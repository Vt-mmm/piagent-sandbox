import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { REPO, makeWorld } from './helpers/world.mjs';
import { loadInPi } from './helpers/pi-session.mjs';

// Acceptance C1: the seven built-in tools are replaced by the sandbox's, as stock Pi 1.3.0 reports them.
const CORE = ['bash', 'read', 'edit', 'write', 'grep', 'find', 'ls'];
const world = makeWorld();
let pi;
before(async () => { pi = await loadInPi(world); });
after(async () => { await pi.close(); world.dispose(); });

test('the package loads into Pi without errors', () => assert.deepEqual(pi.errors, []));

test('getAllTools: bash, read, edit, write, grep, find and ls come from piagent-sandbox, not from Pi', () => {
  for (const name of CORE) {
    const tool = pi.seen.tools.find(item => item.name === name);
    assert.ok(tool, name);
    assert.notEqual(tool.sourceInfo.source, 'builtin', `${name} is still Pi's own`);
    assert.ok(!tool.sourceInfo.path.startsWith('builtin:'), name);
    assert.equal(fs.realpathSync(tool.sourceInfo.path), fs.realpathSync(path.join(REPO, 'src/index.mjs')), name);
  }
});

test('the approval and process tools are there too, from the same package', () => {
  for (const name of ['run_with_network', 'start_docker', 'run_on_host', 'run_on_simulator', 'fetch_origin', 'start_process', 'process_output', 'stop_process']) {
    const tool = pi.seen.tools.find(item => item.name === name);
    if (name.endsWith('process') || name === 'process_output') { if (process.platform !== 'darwin') continue; }
    assert.ok(tool, name);
    assert.equal(fs.realpathSync(tool.sourceInfo.path), fs.realpathSync(path.join(REPO, 'src/index.mjs')), name);
  }
});

test('tools.attest names the seven tools with this package as the source, and the permission mode is announced', () => {
  const attest = pi.seen.events.filter(event => event.channel === 'piagent:tools.attest').at(-1)?.data;
  assert.equal(attest.v, 1);
  for (const name of CORE) assert.deepEqual(attest.tools.find(tool => tool.name === name), { name, source: 'piagent-sandbox' });
  assert.deepEqual(pi.seen.events.filter(event => event.channel === 'piagent:permission.mode').at(-1)?.data, { v: 1, mode: 'ask' });
});

test('a replaced tool runs in the sandbox: it reads the project and is refused ~/.ssh', async () => {
  const tools = pi.session.agent.state.tools ?? pi.session.getActiveToolNames?.();
  assert.ok(tools);
  const run = pi.session.agent.state.tools.find(tool => tool.name === 'read');
  const ok = await run.execute('t1', { path: 'hello.txt' });
  assert.match(ok.content[0].text, /hello from the project/);
  await assert.rejects(run.execute('t2', { path: world.files.ssh }), /managed-sandbox-denied|ENOENT/);
});

test('grep and find work from inside the sandbox', async () => {
  const get = name => pi.session.agent.state.tools.find(tool => tool.name === name);
  assert.match((await get('grep').execute('t3', { pattern: 'project' })).content[0].text, /hello\.txt/);
  assert.match((await get('find').execute('t4', { pattern: '*.txt' })).content[0].text, /hello\.txt/);
});
