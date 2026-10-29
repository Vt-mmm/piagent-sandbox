import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { makeWorld } from './helpers/world.mjs';

// Acceptance C6: /undo puts back the files the previous turn changed, deleted or created; /undo again goes back one more turn;
// it refuses while a turn runs and when the member changed a file again; git's index, HEAD and ignored files are left alone.
const world = makeWorld();
const at = name => path.join(world.project, name);
const read = name => fs.readFileSync(at(name), 'utf8');
const git = (...args) => execFileSync('git', ['-C', world.project, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: world.home, GIT_CONFIG_NOSYSTEM: '1' } });
let host;
before(async () => {
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(at('.gitignore'), 'ignored.log\nnode_modules/\n');
  fs.writeFileSync(at('keep.txt'), 'keep\n'); fs.writeFileSync(at('gone.txt'), 'will be deleted\n'); fs.writeFileSync(at('ignored.log'), 'ignored v1\n');
  git('add', '-A', ':!.env', ':!.npmrc'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(at('staged.txt'), 'staged\n'); git('add', 'staged.txt');
  host = await loadWithFakePi(world);
});
after(async () => { await host.close(); world.dispose(); });
const undo = async () => { await host.commands.undo.handler('', host.ctx); return host.ui.notes.at(-1); };
const snapshot = () => ({ head: git('rev-parse', 'HEAD'), index: git('write-tree') });

test('/undo restores the files of the last turn, one turn at a time, and leaves the index and HEAD alone', async () => {
  await host.turn(async () => {
    await host.mutate('write', { path: 'turn1-new.txt', content: 'one\n' });
    await host.mutate('edit', { path: 'keep.txt', edits: [{ oldText: 'keep', newText: 'keep v1' }] });
  });
  await host.turn(async () => {
    await host.mutate('write', { path: 'turn2-new.txt', content: 'two\n' });
    await host.mutate('edit', { path: 'keep.txt', edits: [{ oldText: 'keep v1', newText: 'keep v2' }] });
    await host.mutate('bash', { command: 'rm gone.txt && echo changed > ignored.log' });
  });
  const before = snapshot();
  assert.equal(read('keep.txt'), 'keep v2\n');
  assert.equal(host.sandbox.checkpoints.depth, 2);

  assert.equal((await undo()).type, 'info');
  assert.equal(read('keep.txt'), 'keep v1\n');
  assert.equal(fs.existsSync(at('turn2-new.txt')), false);
  assert.equal(read('gone.txt'), 'will be deleted\n');
  assert.equal(read('ignored.log'), 'changed\n', 'a .gitignore file is outside the checkpoint');
  assert.deepEqual(snapshot(), before, 'index and HEAD are untouched');
  assert.match(git('status', '--porcelain=v1'), /^A  staged\.txt$/m, 'the staged file is still staged');

  assert.equal((await undo()).type, 'info');
  assert.equal(read('keep.txt'), 'keep\n');
  assert.equal(fs.existsSync(at('turn1-new.txt')), false);
  assert.match((await undo()).message, /Không có lượt nào/);
});

test('/undo refuses when the member edited a file again after the turn, and changes nothing', async () => {
  await host.turn(async () => {
    await host.mutate('write', { path: 'doc.txt', content: 'agent version\n' });
    await host.mutate('write', { path: 'other.txt', content: 'agent other\n' });
  });
  fs.writeFileSync(at('doc.txt'), 'member edit\n');
  const result = await undo();
  assert.equal(result.type, 'warning');
  assert.match(result.message, /doc\.txt/);
  assert.equal(read('doc.txt'), 'member edit\n');
  assert.equal(read('other.txt'), 'agent other\n', 'no file was restored');
  fs.writeFileSync(at('doc.txt'), 'agent version\n');
  assert.equal((await undo()).type, 'info');
  assert.equal(fs.existsSync(at('doc.txt')), false);
});

test('/undo refuses while a turn is running', async () => {
  await host.fire('before_agent_start', { messageType: 'user' }, host.ctx);
  await host.mutate('write', { path: 'busy.txt', content: 'x\n' });
  const busy = await undo();
  assert.equal(busy.type, 'warning');
  assert.match(busy.message, /Đang chạy/);
  await host.fire('agent_end', {}, host.ctx);
  await host.fire('agent_settled', {}, host.ctx);
  assert.equal((await undo()).type, 'info');
  assert.equal(fs.existsSync(at('busy.txt')), false);
});

test('a turn that changed nothing leaves nothing to undo', async () => {
  const depth = host.sandbox.checkpoints.depth;
  await host.turn(async () => { await host.mutate('bash', { command: 'ls' }); });
  assert.equal(host.sandbox.checkpoints.depth, depth);
});

test('a checkpoint that fails does not block the edit', async () => {
  const tree = host.sandbox.checkpoints.tree, original = tree.snapshot;
  tree.snapshot = () => { throw new Error('disk full'); };
  try {
    await host.turn(async () => { await host.mutate('write', { path: 'no-checkpoint.txt', content: 'still written\n' }); });
  } finally { tree.snapshot = original; }
  assert.equal(read('no-checkpoint.txt'), 'still written\n');
  assert.match((await undo()).message, /Không có lượt nào|file/);
});

test('a snapshot of 4000 files is fast, and a project outside git is checkpointed too', async () => {
  const plain = makeWorld();
  try {
    for (let i = 0; i < 4000; i += 1) {
      const dir = path.join(plain.project, `d${i % 40}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `f${i}.txt`), `file ${i}\n`);
    }
    const other = await loadWithFakePi(plain);
    const started = Date.now();
    await other.turn(async () => { await other.mutate('write', { path: 'd0/f0.txt', content: 'changed\n' }); });
    const took = Date.now() - started;
    console.log(`# snapshot+finish of 4000 files: ${took} ms`);
    assert.ok(took < 15000, `${took} ms`);
    await other.commands.undo.handler('', other.ctx);
    assert.equal(fs.readFileSync(path.join(plain.project, 'd0/f0.txt'), 'utf8'), 'file 0\n');
    await other.close();
  } finally { plain.dispose(); }
});
