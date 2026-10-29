import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { makeWorld } from './helpers/world.mjs';

// F038: a member's `!command` and `!!command` run in the sandbox, not on the host.
const world = makeWorld();
let host, operations;
before(async () => {
  host = await loadWithFakePi(world);
  [{ operations }] = await host.fire('user_bash', { command: 'x', excludeFromContext: false, cwd: world.project }, host.ctx);
});
after(async () => { await host.close(); world.dispose(); });
const run = async command => {
  const chunks = [];
  const { exitCode } = await operations.exec(command, world.project, { onData: data => chunks.push(data.toString()) });
  return { exitCode, out: chunks.join('') };
};

test('the member\'s command runs inside the project and prints its output', async () => {
  const ok = await run('cat hello.txt');
  assert.equal(ok.exitCode, 0);
  assert.match(ok.out, /hello from the project/);
});

test('the same blocklist applies: credentials are unreadable and a failing command keeps its exit code', async () => {
  const secret = await run(`cat '${world.files.ssh}'`);
  assert.notEqual(secret.exitCode, 0);
  assert.ok(!secret.out.includes('SYNTHETIC-SECRET-VALUE'));
  const failing = await run('exit 3');
  assert.equal(failing.exitCode, 3);
});
