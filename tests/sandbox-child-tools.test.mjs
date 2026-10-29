import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { makeWorld } from './helpers/world.mjs';

// Helper sessions (harness) ask for read-only tools over the bus: read, grep, find, ls, and bash without network on request.
const world = makeWorld();
let host;
before(async () => { host = await loadWithFakePi(world); });
after(async () => { await host.close(); world.dispose(); });
const ask = request => new Promise(resolve => host.pi.events.emit('piagent:tools.child', { v: 1, readOnly: true, commands: false, web: false, ...request, reply: resolve }));

test('a helper gets read-only tools, never edit or write, and they run in the sandbox', async () => {
  const reply = await ask({ key: 'review-1' });
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.tools.map(tool => tool.name).sort(), ['find', 'grep', 'ls', 'read']);
  const read = reply.tools.find(tool => tool.name === 'read');
  assert.match((await read.execute('id', { path: 'hello.txt' }, undefined, undefined, {})).content[0].text, /hello from the project/);
  await assert.rejects(read.execute('id', { path: world.files.ssh }, undefined, undefined, {}));
});

test('commands:true adds bash that cannot write the project; invalid requests are refused', async () => {
  const reply = await ask({ key: 'review-2', commands: true });
  assert.ok(reply.tools.some(tool => tool.name === 'bash') && !reply.tools.some(tool => ['edit', 'write'].includes(tool.name)));
  const bash = reply.tools.find(tool => tool.name === 'bash');
  await assert.rejects(bash.execute('id', { command: 'echo x > helper.txt' }, undefined, undefined, {}));
  assert.equal((await ask({ key: 'k', readOnly: false })).ok, false);
  assert.equal((await ask({ key: undefined })).ok, false);
  host.pi.events.emit('piagent:tools.child.close', { key: 'review-2' });
});
