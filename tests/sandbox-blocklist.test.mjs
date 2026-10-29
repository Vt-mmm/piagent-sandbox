import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { attempt, darwin, makeWorld, openBoundary } from './helpers/world.mjs';

// The blocklist (acceptance C2): what a command must not reach, and what it still may. A fake HOME holds synthetic secrets; the
// real home, Keychain and Agent Watch are never touched. Runs on macOS (Seatbelt) and Linux (bubblewrap).
const world = makeWorld();
let tools;
before(() => { tools = openBoundary(world); });
after(async () => { await tools.boundary.dispose(); world.dispose(); });
const SECRET = 'SYNTHETIC-SECRET-VALUE';
const bash = command => attempt(tools.call('bash', { command }));
const read = file => attempt(tools.call('read', { path: file }));

test('~/.ssh, Keychain, .env, .npmrc and Agent Watch files cannot be read by any tool', async () => {
  // macOS: the read fails. Linux: a credential file inside the project reads as empty, and the member's hidden files are not mounted.
  for (const file of [world.files.ssh, world.files.keychain, world.files.watch, world.files.homeNpmrc, world.files.env, world.files.npmrc]) {
    for (const result of [await read(file), await bash(`cat '${file}'`)]) {
      assert.ok(!result.out.includes(SECRET), `${file} leaked`);
      if (darwin) assert.equal(result.ok, false, file);
    }
  }
  for (const file of [world.files.ssh, world.files.keychain, world.files.watch, world.files.homeNpmrc]) assert.equal((await read(file)).ok, false, file);
});

test('a command cannot write outside the project, and cannot change the project\'s credential files', async () => {
  const outside = path.join(world.outside, 'new.txt'), planted = path.join(world.home, 'planted');
  for (const result of [await attempt(tools.call('write', { path: outside, content: 'x' })), await bash(`echo x > '${outside}'`), await bash(`echo x > '${planted}'`),
    await bash(`echo x > '${world.files.env}'`), await bash(`rm -f '${world.files.npmrc}'`)]) assert.equal(result.ok, false);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(planted), false);
  assert.equal(fs.readFileSync(world.files.env, 'utf8').trim(), SECRET);
  assert.equal(fs.readFileSync(world.files.npmrc, 'utf8').trim(), SECRET);
});

test('no outside network: a connection to a public or internal address fails at once, not by timeout', async () => {
  const probe = host => bash(`node -e "const s=require('net').connect({host:'${host}',port:80,timeout:4000});`
    + `s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});s.on('error',e=>{console.log('ERR '+e.code);process.exit(2)});s.on('timeout',()=>{console.log('ERR TIMEOUT');process.exit(3)})"`);
  for (const host of ['192.0.2.1', '10.0.0.1', '169.254.169.254', '8.8.8.8']) {
    const result = await probe(host);
    assert.ok(!result.out.includes('CONNECTED'), host);
    assert.ok(!/ERR TIMEOUT/.test(result.out), `${host} should be refused by the sandbox, not time out: ${result.out.slice(0, 200)}`);
  }
});

test('name lookups fail: a command cannot resolve names, and the curl of a stranger gets nothing', async () => {
  const result = await bash('curl -sS -m 5 -o /dev/null https://example.com 2>&1; echo "exit=$?"');
  assert.ok(!/exit=0\b/.test(result.out), result.out);
});

test('inside the project: read, write, edit, search and run a test still work', async () => {
  assert.match((await read(path.join(world.project, 'hello.txt'))).out, /hello from the project/);
  assert.equal((await attempt(tools.call('write', { path: 'src/add.mjs', content: 'export const add = (a, b) => a + b;\n' }))).ok, true);
  assert.equal((await attempt(tools.call('edit', { path: 'src/add.mjs', edits: [{ oldText: 'a + b', newText: 'a + b + 0' }] }))).ok, true);
  fs.writeFileSync(path.join(world.project, 'add.test.mjs'),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from './src/add.mjs'; test('add', () => assert.equal(add(1, 2), 3));\n");
  const run = await bash('node --test add.test.mjs 2>&1 | grep -E "^# (pass|fail)"');
  assert.equal(run.ok, true, run.out);
  assert.match(run.out, /# pass 1/);
  assert.match((await attempt(tools.call('grep', { pattern: 'hello' }))).out, /hello\.txt/);
  assert.match((await attempt(tools.call('ls', {}))).out, /hello\.txt/);
});

test('a server the command starts on 127.0.0.1 is reachable from the same command', async () => {
  const script = "const h=require('http'),s=h.createServer((q,r)=>r.end('pong')).listen(0,'127.0.0.1',()=>{"
    + "h.get({host:'127.0.0.1',port:s.address().port},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('GOT '+d);s.close()})})})";
  const result = await bash(`node -e "${script}"`);
  assert.match(result.out, /GOT pong/);
});

test('the temporary folder is private and writable; /tmp stays read-only with a way forward in the error', async () => {
  assert.equal((await bash('echo ok > "$TMPDIR/scratch" && cat "$TMPDIR/scratch"')).out.trim(), 'ok');
  if (process.platform === 'darwin') {
    const result = await bash('echo x > /tmp/piagent-blocklist-probe');
    assert.equal(result.ok, false);
    assert.match(result.out, /TMPDIR/);
  }
});
