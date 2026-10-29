import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { languageEnvironment } from '../src/language-environment.mjs';
import { containerEngine, engineLauncher } from '../src/container-engine.mjs';
import { developerTools, managedGit, searchToolPath, userToolchains } from '../src/toolchain.mjs';

// Parity F008: the machine's toolchains are readable, never writable; package caches live outside the project, per project, under the fake HOME here.
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolchain-')));

test('toolchains the member installed are found by path and put on PATH, with the variables their shims need', () => {
  const home = tmp();
  try {
    for (const dir of ['.nvm', '.cargo/bin', '.pyenv/shims', '.sdkman/candidates/java/current/bin', 'go/bin', '.local/bin']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    const found = userToolchains(home);
    assert.ok(found.roots.some(root => root.endsWith('.cargo')));
    assert.ok(found.bins.some(bin => bin.endsWith('.cargo/bin')) && found.bins.some(bin => bin.endsWith('.pyenv/shims')) && found.bins.some(bin => bin.endsWith('java/current/bin')));
    assert.equal(found.env.CARGO_HOME, path.join(home, '.cargo'));
    assert.equal(found.env.GOMODCACHE, path.join(home, 'go/pkg/mod'));
    assert.ok(!found.roots.some(root => root.includes('.ssh')));
    assert.deepEqual(userToolchains(tmp()).bins, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('git is pinned to an installed binary, and the developer tools resolve without throwing', () => {
  assert.ok(path.isAbsolute(managedGit()));
  const developer = developerTools();
  assert.ok(Array.isArray(developer.roots) && Array.isArray(developer.bins) && typeof developer.env === 'object');
  assert.equal(searchToolPath('definitely-not-a-tool', tmp()), null);
});

test('package caches are per project, private, outside the project, and refreshed by use', () => {
  const home = tmp(), sandboxHome = tmp();
  try {
    const one = languageEnvironment({ userHome: home, repositoryTop: '/projects/one', home: sandboxHome });
    const two = languageEnvironment({ userHome: home, repositoryTop: '/projects/two', home: sandboxHome });
    assert.notEqual(one.cache, two.cache);
    assert.ok(one.cache.startsWith(home), 'under the member\'s (fake) home, not in the project');
    assert.equal(fs.statSync(one.cache).mode & 0o777, 0o700);
    assert.equal(one.env.offline.npm_config_cache, path.join(one.cache, 'npm'));
    assert.equal(one.env.offline.PIP_CACHE_DIR, path.join(one.cache, 'pip'));
    assert.equal(one.env.offline.GOPROXY.endsWith('off'), true, 'Go does not reach a proxy offline');
    assert.match(one.env.network.GOPROXY, /proxy\.golang\.org/);
    assert.ok(one.writeRoots.includes(one.cache));
    const old = Date.now() / 1000 - 40 * 24 * 3600;
    fs.utimesSync(two.cache, old, old);
    languageEnvironment({ userHome: home, repositoryTop: '/projects/one', home: sandboxHome });
    assert.equal(fs.existsSync(two.cache), false, 'a cache unused for a month is removed');
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(sandboxHome, { recursive: true, force: true }); }
});

test('a Docker engine is found only by its socket and CLI; the launcher names the app that starts it', () => {
  const home = tmp();
  try {
    assert.equal(containerEngine({ userHome: home, env: {}, paths: [], system: false }), null);
    const launcher = engineLauncher({ userHome: home, platform: 'darwin', exists: file => file === '/Applications/OrbStack.app' });
    assert.equal(launcher.label, 'OrbStack');
    assert.deepEqual(launcher.args.slice(0, 2), ['-g', '-a']);
    assert.equal(engineLauncher({ userHome: home, platform: 'darwin', exists: () => false }), null);
    assert.equal(engineLauncher({ userHome: home, platform: 'linux', exists: () => false }), null);
    assert.equal(engineLauncher({ userHome: home, platform: 'linux', exists: file => file === '/usr/lib/systemd/user/docker.service' }).command, '/usr/bin/systemctl');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
