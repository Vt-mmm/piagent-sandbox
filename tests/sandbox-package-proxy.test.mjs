import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { DEFAULT_DOMAINS, PackageProxy, domainAllowed, memberDomains, proxyEnvironment } from '../src/package-proxy.mjs';
import { attempt, makeWorld, openBoundary } from './helpers/world.mjs';

// Package proxy (acceptance C3): registries are reached without asking, strangers are refused with managed-domain-blocked. The
// registries here are fakes on 127.0.0.1; the proxy is told to resolve the real registry names to them. Nothing leaves the machine.
const closers = [];
after(async () => { for (const close of closers.reverse()) await close(); });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => { closers.push(() => new Promise(done => server.close(() => done()))); resolve(server.address().port); }));
const loopback = [{ address: '127.0.0.1', family: 4 }];

function connect(proxyPort, target) {
  return new Promise(resolve => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (/^HTTP\/1\.1 200/.test(data) && data.includes('\r\n\r\n') && !socket.sentPing) { socket.sentPing = true; socket.write('ping'); }
      if (/ECHO:ping/.test(data) || /^HTTP\/1\.1 (403|502)/.test(data)) { socket.destroy(); resolve(data); }
    });
    socket.on('error', () => resolve(data));
    socket.setTimeout(3000, () => { socket.destroy(); resolve(data); });
  });
}
async function startProxy(options) {
  const proxy = new PackageProxy(options);
  const { port } = await proxy.listen();
  closers.push(() => proxy.close());
  return { proxy, port };
}

describe('the proxy itself', () => {
  test('an allowed registry name is tunnelled to the address the proxy checked', async () => {
    const echo = net.createServer(socket => socket.on('data', chunk => socket.write(`ECHO:${chunk}`)));
    const echoPort = await listen(echo);
    const { port } = await startProxy({ resolve: () => loopback, isPrivate: () => false, ports: [echoPort] });
    assert.match(await connect(port, `registry.npmjs.org:${echoPort}`), /ECHO:ping/);
  });

  test('DNS rebinding: an allowed name that resolves to this machine or a private network is refused', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '::1', '::ffff:7f00:1', 'fd00::1']) {
      const { proxy, port } = await startProxy({ resolve: () => [{ address }] });
      assert.match(await connect(port, 'registry.npmjs.org:443'), /^HTTP\/1\.1 403/, address);
      assert.deepEqual(proxy.deniedSince(0), ['registry.npmjs.org']);
    }
    // One public and one private answer: still refused.
    const { port } = await startProxy({ resolve: () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] });
    assert.match(await connect(port, 'pypi.org:443'), /^HTTP\/1\.1 403/);
  });

  test('IP literals, other ports and unknown hosts are refused and remembered by name', async () => {
    const { proxy, port } = await startProxy({ resolve: () => [{ address: '8.8.8.8' }] });
    for (const target of ['8.8.8.8:443', '[::1]:443', 'registry.npmjs.org:22', 'evil.example:443', 'registry.npmjs.org.evil.example:443']) {
      assert.match(await connect(port, target), /^HTTP\/1\.1 403/, target);
    }
    assert.deepEqual(proxy.deniedSince(0).slice(-2), ['evil.example', 'registry.npmjs.org.evil.example']);
  });

  test('a name that cannot be looked up is refused, not passed to an upstream proxy', async () => {
    const { port } = await startProxy({ resolve: async () => { throw new Error('ENOTFOUND'); } });
    assert.match(await connect(port, 'pypi.org:443'), /^HTTP\/1\.1 403/);
  });

  test('registry list, member domains file and proxy environment', () => {
    for (const host of ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'crates.io', 'repo.maven.apache.org', 'api.nuget.org',
      'rubygems.org', 'packagist.org', 'pub.dev'])
      assert.ok(DEFAULT_DOMAINS.includes(host), host);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domains-'));
    const file = path.join(dir, 'sandbox-domains');
    fs.writeFileSync(file, '# company registries\nnpm.corp.example\n*.mirror.example # wildcard\nnot a host\n127.0.0.1\n');
    const extra = memberDomains(file);
    assert.deepEqual(extra, ['npm.corp.example', '*.mirror.example']);
    assert.equal(domainAllowed('npm.corp.example', extra), true);
    assert.equal(domainAllowed('a.b.mirror.example', extra), true);
    assert.equal(domainAllowed('mirror.example', extra), false);
    assert.equal(domainAllowed('127.0.0.1', ['127.0.0.1']), false);
    assert.deepEqual(memberDomains(path.join(dir, 'missing')), []);
    const env = proxyEnvironment('http://127.0.0.1:3128');
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128');
    assert.match(env.GRADLE_OPTS, /-Dhttps\.proxyPort=3128/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// Fake registries: npm (packument + tarball) and PyPI (simple index + wheel), served from one port. The names the proxy allows
// (registry.npmjs.org, pypi.org, files.pythonhosted.org) all resolve here.
function buildNpmPackage(dir) {
  const source = path.join(dir, 'package');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fakepkg', version: '1.0.0', main: 'index.js' }));
  fs.writeFileSync(path.join(source, 'index.js'), "module.exports = 'fake-registry-package';\n");
  execFileSync('tar', ['-czf', path.join(dir, 'fakepkg-1.0.0.tgz'), '-C', dir, 'package']);
  return fs.readFileSync(path.join(dir, 'fakepkg-1.0.0.tgz'));
}
function buildWheel(dir) {
  const wheel = path.join(dir, 'fakepip-1.0-py3-none-any.whl');
  const script = `import zipfile\nz = zipfile.ZipFile(${JSON.stringify(wheel)}, 'w')\nz.writestr('fakepip.py', 'VALUE = "fake-pypi-package"\\n')\n`
    + "z.writestr('fakepip-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: fakepip\\nVersion: 1.0\\n')\n"
    + "z.writestr('fakepip-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nGenerator: test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n')\n"
    + "z.writestr('fakepip-1.0.dist-info/RECORD', '')\nz.close()\n";
  execFileSync('python3', ['-I', '-c', script]);
  return fs.readFileSync(wheel);
}

describe('through the sandbox', () => {
  const world = makeWorld();
  const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-fixtures-'));
  let tools, registryPort, hits = [];
  const python = spawnSync('python3', ['-c', 'import venv, ensurepip']).status === 0;
  before(async () => {
    const tarball = buildNpmPackage(fixtures), wheel = python ? buildWheel(fixtures) : null;
    const server = http.createServer((request, response) => {
      hits.push(`${request.headers.host}${request.url}`);
      const host = String(request.headers.host).split(':')[0];
      if (host === 'registry.npmjs.org' && request.url === '/fakepkg') {
        const url = `http://registry.npmjs.org:${registryPort}/fakepkg/-/fakepkg-1.0.0.tgz`;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ name: 'fakepkg', 'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name: 'fakepkg', version: '1.0.0', dist: { tarball: url, shasum: createHash('sha1').update(tarball).digest('hex') } } } }));
      } else if (host === 'registry.npmjs.org' && request.url.endsWith('.tgz')) response.end(tarball);
      else if (host === 'pypi.org' && /^\/simple\/fakepip\/?$/.test(request.url)) {
        response.setHeader('content-type', 'text/html');
        response.end(`<a href="http://files.pythonhosted.org:${registryPort}/packages/fakepip-1.0-py3-none-any.whl">fakepip-1.0-py3-none-any.whl</a>`);
      } else if (host === 'files.pythonhosted.org' && wheel) response.end(wheel);
      else { response.statusCode = 404; response.end('not found'); }
    });
    registryPort = await listen(server);
    tools = openBoundary(world, { proxy: { resolve: () => loopback, isPrivate: () => false, ports: [registryPort, 80, 443] } });
    await tools.boundary.proxyReady;
  });
  after(async () => { await tools.boundary.dispose(); world.dispose(); fs.rmSync(fixtures, { recursive: true, force: true }); });
  const bash = command => attempt(tools.call('bash', { command }));

  test('npm install reaches the registry through the proxy without asking', async () => {
    const result = await bash(`npm init -y >/dev/null && npm install --no-audit --no-fund --registry=http://registry.npmjs.org:${registryPort}/ fakepkg 2>&1 && node -p "require('fakepkg')"`);
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /fake-registry-package/);
    assert.ok(hits.some(hit => hit.startsWith('registry.npmjs.org')), 'the proxy forwarded the request');
  });

  test('pip install in a venv reaches the index through the proxy without asking', { skip: !python && 'python3 with venv is not available' }, async () => {
    const result = await bash(`python3 -m venv .venv && .venv/bin/pip install --disable-pip-version-check --no-cache-dir --index-url http://pypi.org:${registryPort}/simple `
      + '--trusted-host pypi.org --trusted-host files.pythonhosted.org fakepip 2>&1 && .venv/bin/python -c "import fakepip; print(fakepip.VALUE)"');
    assert.equal(result.ok, true, result.out);
    assert.match(result.out, /fake-pypi-package/);
  });

  test('managed-domain-blocked names run_with_network and the refused host', async () => {
    const before = hits.length;
    const result = await bash(`curl -sS -f -m 10 http://unknown-registry.example:${registryPort}/pkg 2>&1`);
    assert.equal(result.ok, false);
    assert.match(result.out, /managed-domain-blocked/);
    assert.match(result.out, /unknown-registry\.example/);
    assert.match(result.out, /run_with_network/);
    assert.equal(hits.length, before, 'the stranger never reached the registry');
  });

  test('a refused npm install of a package from a stranger fails with managed-domain-blocked', async () => {
    const result = await bash('npm install --no-audit --no-fund --fetch-retries=0 --registry=http://stranger.example/ other 2>&1');
    assert.equal(result.ok, false);
    assert.match(result.out, /managed-domain-blocked/);
  });
});
