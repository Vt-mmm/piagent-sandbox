import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { attempt, darwin, makeWorld, openBoundary } from './helpers/world.mjs';

// (ps cannot read the environment of Apple's own binaries, so the stray here is a node process.)
// Parity F010: a command stops at its timeout, can be cancelled, may print a lot, and leaves nothing behind when the turn ends.
const world = makeWorld();
let tools;
before(() => { tools = openBoundary(world); });
after(async () => { await tools.boundary.dispose(); world.dispose(); });

test('a command stops at its own timeout', { timeout: 60000 }, async () => {
  const started = Date.now();
  const result = await attempt(tools.call('bash', { command: 'sleep 30', timeout: 1 }));
  assert.equal(result.ok, false);
  assert.match(result.out, /timed out/i);
  assert.ok(Date.now() - started < 15000);
});

test('a cancelled command stops at once', { timeout: 60000 }, async () => {
  const controller = new AbortController();
  const pending = attempt(tools.call('bash', { command: 'sleep 30' }, controller.signal));
  setTimeout(() => controller.abort(), 500);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.out, /abort|cancel/i);
});

test('a command that prints a lot for several seconds is not cut', { timeout: 60000 }, async () => {
  const result = await attempt(tools.call('bash', { command: 'for i in $(seq 1 3000); do echo "line $i of build output"; done; echo finished' }));
  assert.equal(result.ok, true);
  assert.match(result.out, /finished/);
});

test('a non-zero exit is an error that keeps the output and the code', async () => {
  const result = await attempt(tools.call('bash', { command: 'echo before; exit 4' }));
  assert.equal(result.ok, false);
  assert.match(result.out, /before/);
  assert.match(result.out, /exited with code 4/);
});

test('a process a command leaves running is stopped when the turn ends', { skip: !darwin && 'stray cleanup by marker is macOS; on Linux the PID namespace ends them', timeout: 60000 }, async () => {
  await tools.call('bash', { command: 'nohup node -e \"setInterval(()=>{},1000)\" stray-marker-300 >/dev/null 2>&1 &\necho started' });
  const marker = `PIAGENT_TOOL_SCOPE=${tools.boundary.scope}`;
  const { execFileSync } = await import('node:child_process');
  const rows = () => execFileSync('/bin/ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
  const count = () => rows().filter(row => row.includes(marker) && row.includes('stray-marker-300')).length;
  assert.ok(count() >= 1, 'the stray is there');
  assert.ok(await tools.boundary.stopStrays() >= 1);
  assert.equal(count(), 0);
});

test('a project that overlaps the runtime, a missing SDK version or a read-only helper are refused or limited', async () => {
  const { ManagedToolBoundary } = await import('../src/tool-boundary.mjs');
  const { SDK_ROOT } = await import('./helpers/world.mjs');
  assert.throws(() => new ManagedToolBoundary({ cwd: SDK_ROOT, sdkRoot: SDK_ROOT, userHome: world.home }), /managed-project-overlaps-runtime/);
  assert.throws(() => new ManagedToolBoundary({ cwd: world.home, sdkRoot: SDK_ROOT, userHome: world.home }), /managed-project-overlaps-runtime/);
  const helper = openBoundary(world, { readOnly: true });
  try {
    assert.deepEqual(Object.keys(helper.tools).sort(), ['find', 'grep', 'ls', 'read']);
    assert.equal((await attempt(helper.call('read', { path: 'hello.txt' }))).ok, true);
  } finally { await helper.boundary.dispose(); }
});
