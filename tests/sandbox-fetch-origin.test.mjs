import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fetchOriginTool, fetchPlan } from '../src/fetch-origin.mjs';
import { attempt, makeWorld, openBoundary } from './helpers/world.mjs';
import { fakeCtx, fakeOwner } from './helpers/fakes.mjs';

// fetch_origin (parity F023): one approved fetch of the GitHub origin. The transport is replaced by a local bare repository, so
// nothing reaches the network; the import into the project runs in the real sandbox.
const world = makeWorld();
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: world.home, GIT_CONFIG_NOSYSTEM: '1' } });
let tools;
after(async () => { await tools?.boundary.dispose(); world.dispose(); });

test('the plan accepts github.com origins only, inside the project', async () => {
  git(world.project, 'init', '-q', '-b', 'main');
  git(world.project, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
  const plan = await fetchPlan(world.project);
  assert.equal(plan.url, 'https://github.com/acme/app.git');
  git(world.project, 'remote', 'set-url', 'origin', 'https://example.org/acme/app.git');
  await assert.rejects(fetchPlan(world.project), /managed-repository-unsupported/);
  await assert.rejects(fetchPlan(world.project, '../elsewhere'), /managed-path-invalid/);
  git(world.project, 'remote', 'set-url', 'origin', 'https://github.com/acme/app');
});

test('Ask first asks; Full access fetches; the branches arrive and the working files do not change', async () => {
  git(world.project, 'config', 'user.name', 'T'); git(world.project, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(world.project, 'a.txt'), 'local\n');
  git(world.project, 'add', 'a.txt'); git(world.project, 'commit', '-q', '-m', 'local');
  const upstream = path.join(world.root, 'upstream');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '-q', '-b', 'main'); git(upstream, 'config', 'user.name', 'T'); git(upstream, 'config', 'user.email', 't@example.invalid');
  fs.writeFileSync(path.join(upstream, 'b.txt'), 'upstream\n');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-q', '-m', 'upstream'); git(upstream, 'branch', 'feature');

  tools = openBoundary(world);
  const calls = [];
  const transport = async (plan, staging) => { calls.push(plan.url); execFileSync('git', ['clone', '-q', '--bare', upstream, staging]); };
  for (const [mode, asks] of [['ask', 1], ['full', 0]]) {
    const { owner } = fakeOwner({ mode });
    owner.boundary = tools.boundary; owner.cwd = world.project;
    const ctx = fakeCtx();
    const tool = fetchOriginTool(owner, { transport });
    const result = await tool.execute('id', {}, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Fetched origin branches for acme\/app/);
    assert.equal(ctx.asked.length, asks, mode);
  }
  assert.equal(calls.length, 2);
  assert.match(git(world.project, 'branch', '-r'), /origin\/feature/);
  assert.equal(fs.readFileSync(path.join(world.project, 'a.txt'), 'utf8'), 'local\n');
  assert.equal(fs.existsSync(path.join(world.project, 'b.txt')), false);
  assert.equal(git(world.project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
});

test('a declined fetch makes no request; a failing transport names run_on_host', async () => {
  const { owner } = fakeOwner();
  owner.boundary = tools.boundary; owner.cwd = world.project;
  let called = false;
  const tool = fetchOriginTool(owner, { transport: async () => { called = true; throw new Error('401 from github'); } });
  await assert.rejects(tool.execute('id', {}, undefined, undefined, fakeCtx([false])), /managed-operation-denied/);
  assert.equal(called, false);
  await assert.rejects(tool.execute('id', {}, undefined, undefined, fakeCtx()), /managed-operation-denied/, 'a declined fetch is not asked again');
  const again = fakeOwner({ mode: 'full' }).owner;
  again.boundary = tools.boundary; again.cwd = world.project;
  const failed = await attempt(fetchOriginTool(again, { transport: async () => { throw new Error('401 from github'); } }).execute('id', {}, undefined, undefined, fakeCtx()));
  assert.equal(failed.ok, false);
  assert.match(failed.out, /managed-repository-fetch-failed.*run_on_host/s);
});
