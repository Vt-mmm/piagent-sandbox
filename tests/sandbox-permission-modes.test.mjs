import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Permission, ENTRY } from '../src/permission.mjs';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { makeWorld } from './helpers/world.mjs';

// The three modes (Ask first, Full access, Bypass), Bypass only when the Harness says so, and the /bypass command.
test('Bypass needs an explicit yes from the Harness; withdrawn, it falls back to Full access', () => {
  const changes = [], saved = [];
  const permission = new Permission({ onChange: mode => changes.push(mode), persist: data => saved.push(data.mode) });
  assert.equal(permission.mode, 'ask');
  assert.throws(() => permission.set('bypass'), /managed-bypass-unavailable/);
  permission.allowBypass('yes');
  assert.throws(() => permission.set('bypass'), /managed-bypass-unavailable/);
  permission.allowBypass(true);
  permission.set('bypass');
  assert.equal(permission.mode, 'bypass');
  permission.allowBypass(false);
  assert.equal(permission.mode, 'full');
  assert.throws(() => permission.set('nonsense'), /managed-permission-unavailable/);
  assert.deepEqual(changes, ['bypass', 'full']);
  assert.deepEqual(saved, ['bypass']);
});

test('the mode is kept with the conversation and restored from its entries', () => {
  const permission = new Permission();
  permission.allowBypass(true);
  permission.restore([{ type: 'custom', customType: ENTRY, data: { mode: 'full' } }, { type: 'custom', customType: 'other', data: { mode: 'bypass' } }]);
  assert.equal(permission.mode, 'full');
  permission.restore([]);
  assert.equal(permission.mode, 'ask');
});

test('what each mode asks about', () => {
  const permission = new Permission();
  permission.allowBypass(true);
  assert.equal(permission.confirmation('npm test'), 'ask');
  permission.set('full');
  assert.equal(permission.confirmation('npm test'), null);
  assert.ok(permission.confirmation('git push'));
  assert.ok(permission.confirmation('rm -rf "$DIR"'));
  permission.set('bypass');
  assert.equal(permission.confirmation('rm -rf "$DIR"'), null);
  assert.ok(permission.confirmation('git push'));
  assert.ok(permission.confirmation('npm publish'));
});

const world = makeWorld();
let host;
before(async () => { host = await loadWithFakePi(world); });
after(async () => { await host.close(); world.dispose(); });
const bypass = async text => { await host.commands.bypass.handler(text, host.ctx); return host.ui.notes.at(-1); };
const modes = () => host.emitted.filter(event => event.channel === 'piagent:permission.mode').map(event => event.data.mode);

test('/bypass: status, refused until the Harness allows it, then on (after a confirmation), full, off', async () => {
  assert.match((await bypass('status')).message, /Ask first/);
  assert.match((await bypass('on')).message, /managed-bypass-unavailable/);
  host.pi.events.emit('piagent:run.state', { v: 1, runId: 'r1', harness: { bypassMode: true } });
  host.ui.asked.length = 0;
  assert.match((await bypass('on')).message, /Bypass/);
  assert.equal(host.ui.asked.length, 1, 'on asks for confirmation');
  assert.equal(host.sandbox.permission.mode, 'bypass');
  assert.match((await bypass('full')).message, /Full access/);
  assert.match((await bypass('off')).message, /Ask first/);
  assert.match((await bypass('bogus')).message, /\/bypass on, full, off, status/);
  assert.equal(host.entries.filter(entry => entry.customType === ENTRY).at(-1).data.mode, 'ask');
  assert.deepEqual(modes().slice(-3), ['bypass', 'full', 'ask']);
});

test('/bypass on declined leaves the mode as it was; the Harness withdrawing Bypass is announced as Full access', async () => {
  host.ui.asked.length = 0;
  host.pi.events.emit('piagent:run.state', { v: 1, runId: 'r2', harness: { bypassMode: true } });
  const answers = host.ui.ui.confirm;
  host.ui.ui.confirm = async () => false;
  await bypass('on');
  host.ui.ui.confirm = answers;
  assert.equal(host.sandbox.permission.mode, 'ask');
  await bypass('on');
  host.pi.events.emit('piagent:run.state', { v: 1, runId: 'r3', harness: { bypassMode: false } });
  assert.equal(host.sandbox.permission.mode, 'full');
  assert.equal(modes().at(-1), 'full');
});
