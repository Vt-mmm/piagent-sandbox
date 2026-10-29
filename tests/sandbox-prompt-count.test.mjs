import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, test } from 'node:test';
import { commandTools } from '../src/command-tools.mjs';
import { byName, fakeCtx, fakeOwner } from './helpers/fakes.mjs';
import { makeWorld, openBoundary, sdk } from './helpers/world.mjs';

// How many times the member is asked while fixing a small bug (read, edit, write, npm test, node --test, git status/diff, a project
// script). The earlier Piagent (managed/) asked for none of these: they run in the sandbox. The count must never exceed that.
// Ask first asks for run_with_network, run_with_docker, run_on_host and run_on_simulator, one card per call, in both versions.
const world = makeWorld();
const git = (...args) => execFileSync('git', ['-C', world.project, '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...args], { stdio: 'ignore' });
let sandbox;
before(() => {
  fs.writeFileSync(path.join(world.project, 'add.js'), 'module.exports = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(world.project, 'add.test.js'), "const test=require('node:test');const a=require('node:assert');test('adds',()=>a.equal(require('./add')(1,2),3));\n");
  fs.writeFileSync(path.join(world.project, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test add.test.js' } }));
  fs.writeFileSync(path.join(world.project, 'run.js'), "console.log('script ran');\n");
  git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');
  sandbox = openBoundary(world);
});
after(() => { sandbox.boundary.dispose?.(); world.dispose(); });

test('fixing a small bug in Ask first asks nothing: every step runs in the sandbox', async () => {
  const ctx = fakeCtx();
  const call = (name, args) => sandbox.tools[name].execute('id', args, undefined, undefined, ctx);
  await call('read', { path: 'add.js' });
  await call('edit', { path: 'add.js', edits: [{ oldText: 'a - b', newText: 'a + b' }] });
  await call('write', { path: 'notes.txt', content: 'x\n' });
  for (const command of ['npm test', 'node --test', 'git status', 'git diff', 'git log --oneline -3', 'node run.js', './node_modules/.bin/../../run.js || node run.js']) {
    await call('bash', { command }).catch(() => {});
  }
  assert.equal(ctx.asked.length, 0);
});

test('Ask first asks one card per call for the tools that leave the sandbox, as before; Full access and Bypass ask only where C1-C4 require', async () => {
  const counts = {};
  for (const mode of ['ask', 'full', 'bypass']) {
    const w = fakeOwner({ mode, engine: { socket: '/tmp/fake.sock', cli: '/usr/local/bin/docker', readRoots: [] } });
    const tools = commandTools(w.owner, { runHost: async () => ({ content: [{ type: 'text', text: 'ok' }] }), alive: async () => true });
    const ctx = fakeCtx();
    const run = (name, command) => byName(tools, name).execute('id', { command, reason: 'task' }, undefined, undefined, ctx);
    await run('run_with_network', 'npm view left-pad'); await run('run_with_network', 'npm view left-pad');
    await run('run_with_docker', 'docker compose up -d');
    await run('run_on_host', 'git status');
    await run('run_on_simulator', 'xcrun simctl list devices');
    counts[mode] = ctx.asked.length;
  }
  // Ask first: one card per call (the earlier version asked once per call as well, a repeat included; only a decline is remembered).
  assert.equal(counts.ask, 5);
  assert.ok(counts.full <= counts.ask && counts.bypass <= counts.ask, JSON.stringify(counts));
});
