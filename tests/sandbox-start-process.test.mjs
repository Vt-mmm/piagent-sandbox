import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { LIFETIME_MS, MAX_PROCESSES } from '../src/background-process.mjs';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { darwin, makeWorld } from './helpers/world.mjs';

// Acceptance C5: start_process runs at most 4 processes in the sandbox, across turns, until stop_process, the end of the
// conversation or 4 hours (a fake clock here). macOS only: the Linux/WSL background sandbox is not built yet (parity F011, F037).
const skip = !darwin && 'start_process is macOS only';
const world = makeWorld();
const timers = [];
const clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
  clearTimeout: timer => { if (timer) timer.cleared = true; },
};
let host;
before(async () => { host = await loadWithFakePi(world, { deps: { processOptions: { clock, poll: 20 } } }); });
after(async () => { await host?.close(); world.dispose(); });
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A stopped child is a zombie until Node reaps it: give it a moment.
const gone = async pid => { for (let i = 0; i < 60 && exists(pid); i += 1) await new Promise(resolve => setTimeout(resolve, 50)); return !exists(pid); };
const SERVER = "node -e \"require('http').createServer((q,r)=>r.end('pong')).listen(0,'127.0.0.1',()=>console.log('server ready'));setInterval(()=>{},1000)\"";
const text = result => result.content[0].text;
const manager = () => host.sandbox.boundary.background;

test('a dev server outlives its turn, is read until it is ready, and answers on 127.0.0.1', { skip, timeout: 60000 }, async () => {
  let id;
  await host.turn(async () => { id = /Started (p\d+)/.exec(text(await host.call('start_process', { command: SERVER, name: 'dev server' })))[1]; });
  // The turn ended and its strays were stopped; the background process was not.
  const entry = manager().get(id);
  assert.equal(entry.status, 'running');
  assert.equal(exists(entry.child.pid), true);
  await host.turn(async () => {
    const output = text(await host.call('process_output', { id, wait_seconds: 20, until: 'server ready' }));
    assert.match(output, /running/);
    assert.match(output, /server ready/);
    assert.match(text(await host.call('process_output', { id })), /no new output/, 'output is read once');
    const probe = await host.call('bash', { command: 'echo no server in the next command: $(curl -s -m 2 http://127.0.0.1:1 || echo none)' });
    assert.match(text(probe), /none/);
  });
  const stopped = text(await host.call('stop_process', { id }));
  assert.match(stopped, /stopped/);
  assert.equal(await gone(entry.child.pid), true);
});

test(`at most ${MAX_PROCESSES} run at once; stopping one frees a slot`, { skip, timeout: 60000 }, async () => {
  const ids = [];
  for (let i = 0; i < MAX_PROCESSES; i += 1) ids.push(/Started (p\d+)/.exec(text(await host.call('start_process', { command: 'sleep 600', name: `sleep ${i}` })))[1]);
  await assert.rejects(host.call('start_process', { command: 'sleep 600' }), /managed-process-limit/);
  await host.call('stop_process', { id: ids[0] });
  ids.push(/Started (p\d+)/.exec(text(await host.call('start_process', { command: 'sleep 600' })))[1]);
  await assert.rejects(host.call('process_output', { id: 'p999' }), /managed-process-unknown/);
});

test('after 4 hours a process stops (fake clock); a stopped process is not stopped twice', { skip, timeout: 60000 }, async () => {
  const running = manager().running();
  assert.ok(running.length >= 1);
  const victim = running[0];
  const timer = timers.find(item => item.ms === LIFETIME_MS && !item.cleared && item === victim.timer);
  assert.ok(timer, 'a 4-hour timer was set');
  timer.fn();
  assert.equal(await gone(victim.child.pid), true);
  assert.equal(victim.status, 'stopped');
  assert.match(victim.reason, /4-hour lifetime/);
  assert.match(text(await host.call('process_output', { id: victim.id })), /stopped \(its 4-hour lifetime ended\)/);
});

test('the end of the conversation stops every background process and its children', { skip, timeout: 60000 }, async () => {
  const pids = manager().running().map(entry => entry.child.pid);
  assert.ok(pids.length >= 1);
  await host.close();
  for (const pid of pids) assert.equal(await gone(pid), true, `pid ${pid}`);
  host = null;
});

test('output is bounded and redacted (no sandbox needed)', async () => {
  const { BackgroundProcesses } = await import('../src/background-process.mjs');
  const { EventEmitter } = await import('node:events');
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: 0 });
  const manager = new BackgroundProcesses({ spawnBackground: async () => ({ child, isolated: false }), stopBackground: async () => {} }, { clock, poll: 5 });
  const { id } = await manager.start('whatever');
  child.stdout.emit('data', Buffer.from('Authorization: Bearer abc123def456\npassword: hunter2 \n'));
  child.stdout.emit('data', Buffer.from('x'.repeat(70 * 1024)));
  const { text: out } = await manager.output(id);
  assert.match(out, /characters not read/);
  child.stdout.emit('data', Buffer.from('token=abcdef1234567890 done\n'));
  const second = await manager.output(id);
  assert.ok(!/abcdef1234567890/.test(second.text));
  const first = await manager.get(id);
  assert.ok(first.text.length <= 64 * 1024);
});
