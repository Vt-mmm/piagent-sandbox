import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { BWRAP, bubblewrapArgs, credentialFiles, credentialName, memberReferences } from '../src/linux-sandbox.mjs';
import { SEATBELT_TERMINAL_RULES, managedSeatbelt } from '../src/seatbelt.mjs';
import { seatbeltTerminal } from '../src/terminal-seatbelt.mjs';

// The two profiles as text: what they open and what they close. Pure: they run on every platform (the real enforcement is
// exercised by sandbox-blocklist.test.mjs on macOS and Linux).
const base = { cwd: '/p/project', sdkRoot: '/s/sdk', runtimeRoot: '/s/runtime', temporary: '/t/tmp', node: '/n/bin/node', denied: ['/h/.ssh', '/h/Library/Keychains'] };

test('Seatbelt: default deny, writes only in the project and the temporary folder, credentials closed', () => {
  const profile = managedSeatbelt(base);
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/t\/tmp"\) \(subpath "\/p\/project"\)/);
  assert.match(profile, /\(deny file-read\* file-write\* \(require-all \(subpath "\/h\/\.ssh"\)/);
  assert.match(profile, /\(subpath "\/h\/Library\/Keychains"\)/);
  assert.match(profile, /\\\.env/);
  assert.match(profile, /\\\.\(npmrc\|netrc\|pypirc\|git-credentials/);
  assert.match(profile, /auth\\\.json/);
  assert.match(profile, /\.env\[-\._\]\(example\|sample\|template\|dist\|defaults\)\$\|cacert/, 'committed templates stay readable');
  assert.ok(!/network-outbound \(remote ip\)/.test(profile), 'no internet without approval');
  assert.ok(!/network-outbound \(remote ip "localhost:\*"\)/.test(profile), 'T3: no loopback without a proxy port or approval');
  assert.match(managedSeatbelt({ ...base, loopback: true }), /network-outbound \(remote ip "localhost:\*"\)/);
});

test('Seatbelt: a read-only helper cannot write the project; network is added only for an approved command; a local proxy closes loopback', () => {
  assert.ok(!/\(allow file-write\*[^)]*"\/p\/project"/.test(managedSeatbelt({ ...base, readOnly: true })));
  assert.match(managedSeatbelt({ ...base, network: true }), /\(allow network-outbound \(remote ip\)\)/);
  const isolated = managedSeatbelt({ ...base, loopback: false });
  assert.ok(!/localhost:\*/.test(isolated.split('\n').filter(line => line.includes('network-outbound')).join('\n')));
  assert.match(managedSeatbelt({ ...base, loopback: false, proxyPort: 4321 }), /network-outbound \(remote ip "localhost:4321"\)/);
  assert.match(managedSeatbelt({ ...base, network: true, docker: '/run/docker.sock' }), /network-outbound \(literal "\/run\/docker\.sock"\)/);
  assert.throws(() => managedSeatbelt({ ...base, cwd: 'relative' }), /managed-path-invalid/);
  assert.throws(() => managedSeatbelt({ ...base, cwd: '/p/"quote' + String.fromCharCode(1) }), /managed-path-invalid/);
});

test('Seatbelt: only the reference folders the member chose are readable; the home folder as a whole is closed', () => {
  const profile = managedSeatbelt({ ...base, references: ['/Users/member/work/api'] });
  assert.match(profile, /\(allow file-read\* \(subpath "\/Users\/member\/work\/api"\)\)/);
  assert.ok(!profile.includes('(subpath "/Users/member")'));
  assert.ok(!profile.includes('/Volumes') && !profile.includes('/Users/Shared'));
  assert.ok(!managedSeatbelt(base).includes('/Users/member'));
});

test('Linux names: the same credential files as macOS, and templates are not credentials', () => {
  for (const name of ['.env', '.env.local', '.npmrc', '.netrc', 'credentials', 'credentials.json']) assert.equal(credentialName(name, '/p', ['/p']), true, name);
  for (const name of ['.env.example', '.env.sample', 'credentials-form.ts', 'envfile']) assert.equal(credentialName(name, '/p', ['/p']), false, name);
  assert.equal(credentialName('auth.json', '/p', ['/p']), true);
  assert.equal(credentialName('auth.json', '/p/src/i18n', ['/p']), false);
  assert.equal(credentialName('auth.json', '/p/.composer', ['/p']), true);
});

test('Linux: credential files are found in the project, never in dependency folders', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cred-')));
  try {
    fs.mkdirSync(path.join(dir, 'api'));
    fs.mkdirSync(path.join(dir, 'node_modules/x'), { recursive: true });
    for (const file of ['.env', 'api/.npmrc', 'node_modules/x/.env', '.env.example', 'api/readme.md']) fs.writeFileSync(path.join(dir, file), 'x');
    const found = credentialFiles([dir]).map(item => path.relative(dir, item.path)).sort();
    assert.deepEqual(found, ['.env', 'api/.npmrc']);
    const list = path.join(dir, 'refs'); fs.writeFileSync(list, `# mine\n${path.join(dir, 'api')}\nrelative/path\n${path.join(dir, 'missing')}\n/\n`);
    assert.deepEqual(memberReferences(list), [path.join(dir, 'api')]);
    assert.deepEqual(memberReferences(null), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bubblewrap: no network by default, everything read-only except the project and the temporary folder, credentials emptied', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bwrap-')));
  try {
    const project = path.join(dir, 'project'), tmp = path.join(dir, 'tmp'), secret = path.join(project, '.env');
    fs.mkdirSync(project); fs.mkdirSync(tmp); fs.writeFileSync(secret, 'x'); fs.writeFileSync(path.join(dir, 'empty'), '');
    const args = bubblewrapArgs({ cwd: project, sdkRoot: dir, runtimeRoot: dir, temporary: tmp, empty: path.join(dir, 'empty'), node: process.execPath,
      credentials: [{ path: secret, directory: false }] });
    const at = flag => args.map((arg, i) => (arg === flag ? args.slice(i + 1, i + 3) : null)).filter(Boolean);
    assert.ok(args.includes('--unshare-net') && args.includes('--die-with-parent') && args.includes('--unshare-pid'));
    assert.ok(at('--bind').some(pair => pair[0] === project) && at('--bind').some(pair => pair[0] === tmp));
    assert.ok(at('--ro-bind').some(pair => pair[1] === secret), 'the credential file is covered by an empty file');
    assert.ok(args.indexOf('--remount-ro') > args.indexOf('--ro-bind'));
    assert.ok(!bubblewrapArgs({ cwd: project, sdkRoot: dir, runtimeRoot: dir, temporary: tmp, empty: path.join(dir, 'empty'), node: process.execPath, network: true }).includes('--unshare-net'));
    const helper = bubblewrapArgs({ cwd: project, sdkRoot: dir, runtimeRoot: dir, temporary: tmp, empty: path.join(dir, 'empty'), node: process.execPath, readOnly: true });
    assert.ok(!helper.some((arg, i) => arg === '--bind' && helper[i + 1] === project));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Linux: the sandbox is available where bubblewrap is installed (CI installs it)', () => {
  if (process.platform === 'linux') assert.ok(BWRAP, 'bubblewrap (bwrap) must be installed on Linux for the sandbox to start');
});

test('the terminal shell runs under the offline profile plus the terminal rules; output is chunked without splitting surrogate pairs', async () => {
  assert.match(SEATBELT_TERMINAL_RULES, /file-ioctl/);
  const spawned = [];
  let onData, onExit;
  const fake = { pid: 0, write: data => spawned.push(['write', data]), resize: (c, r) => spawned.push(['resize', c, r]), onData: fn => { onData = fn; }, onExit: fn => { onExit = fn; } };
  const pty = { spawn: (file, args, options) => { spawned.push([file, args, options]); return fake; } };
  const messages = [];
  const terminal = seatbeltTerminal({ pty, profile: '(version 1)', cwd: '/p', env: {}, size: { cols: 80, rows: 24 }, emit: message => messages.push(message) });
  assert.equal(spawned[0][0], '/usr/bin/sandbox-exec');
  assert.equal(spawned[0][1][0], '-p');
  assert.ok(spawned[0][1][1].includes('file-ioctl'));
  onData('a'.repeat(8191) + '😀' + 'b');
  const chunks = messages.filter(message => message.kind === 'output').map(message => message.data);
  assert.equal(chunks.join(''), 'a'.repeat(8191) + '😀' + 'b');
  assert.ok(chunks.every(chunk => !/[\uD800-\uDBFF]$/.test(chunk)));
  await terminal.execute({ kind: 'input', data: 'ls\n' });
  await terminal.execute({ kind: 'resize', cols: 100, rows: 30 });
  assert.deepEqual(spawned.slice(1), [['write', 'ls\n'], ['resize', 100, 30]]);
  onExit({ exitCode: 0, signal: 0 });
  await terminal.completed;
  assert.deepEqual(messages.at(-1), { kind: 'exit', exitCode: 0, signal: null });
  await assert.rejects(terminal.execute({ kind: 'input', data: 'x' }), /managed-terminal-exited/);
  await terminal.close();
});
