import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { emptySnapshot, readChangedFiles, readHead, readPatchDigest, readPatchSnapshot, resolveReviewBase, reviewUnavailableReason } from '../src/patch-snapshot.mjs';
import { makeWorld } from './helpers/world.mjs';

const world = makeWorld();
const cwd = world.project;
const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: world.home, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
const write = (name, text) => fs.writeFileSync(path.join(cwd, name), text);
before(() => {
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'T'); git('config', 'user.email', 't@example.invalid');
  write('a.txt', 'one\n'); write('b.txt', 'one\n'); write('.gitignore', '.env\n.npmrc\n');
  git('add', 'a.txt', 'b.txt', 'hello.txt', '.gitignore'); git('commit', '-q', '-m', 'base');
});
after(() => world.dispose());

test('the digest follows the patch: no change is empty, an edit or a new file changes it, the same state gives the same digest', () => {
  assert.equal(emptySnapshot(readPatchSnapshot(cwd)), true);
  const clean = readPatchDigest(cwd);
  write('a.txt', 'two\n');
  const edited = readPatchDigest(cwd);
  assert.notEqual(edited, clean);
  assert.equal(readPatchDigest(cwd), edited);
  write('new.txt', 'new file\n');
  assert.notEqual(readPatchDigest(cwd), edited);
  const snapshot = readPatchSnapshot(cwd);
  assert.equal(emptySnapshot(snapshot), false);
  const value = JSON.parse(snapshot.patch);
  assert.match(value.patch, /\+two/);
  assert.deepEqual(value.untracked.map(file => file.path), ['new.txt']);
  assert.ok(!JSON.stringify(value).includes('SYNTHETIC'), 'ignored credential files are not part of the patch');
});

test('a scope narrows the patch; a base commit keeps commits made during the turn in it', () => {
  const scoped = JSON.parse(readPatchSnapshot(cwd, { scope: new Set(['new.txt']) }).patch);
  assert.equal(scoped.patch, '');
  assert.equal(scoped.untracked.length, 1);
  const start = readHead(cwd);
  assert.match(start, /^[0-9a-f]{40}$/);
  git('add', '-A'); git('commit', '-q', '-m', 'during the turn');
  assert.equal(emptySnapshot(readPatchSnapshot(cwd)), true);
  const since = JSON.parse(readPatchSnapshot(cwd, { base: start }).patch);
  assert.match(since.patch, /\+two/);
  assert.equal(resolveReviewBase(cwd, 'HEAD~1'), start);
  assert.equal(resolveReviewBase(cwd, '--upload-pack=x'), null);
  assert.equal(resolveReviewBase(cwd, 'no-such-ref'), null);
});

test('changed files are named by hash, so a command answers for its own changes', () => {
  const before = readChangedFiles(cwd);
  write('b.txt', 'changed by the command\n');
  write('c.txt', 'created\n');
  const after = readChangedFiles(cwd);
  const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file).sort();
  assert.deepEqual(changed, ['b.txt', 'c.txt']);
  assert.ok(![...after.keys()].some(file => /\.env|\.npmrc/.test(file)));
});

test('outside a repository there is no head, and the reason is named', () => {
  assert.equal(readHead(world.root), null);
  assert.throws(() => readPatchSnapshot(world.root));
  assert.equal(reviewUnavailableReason('fatal: not a git repository'), 'not_git');
  assert.equal(reviewUnavailableReason('review-patch-limit'), 'too_large');
  assert.equal(reviewUnavailableReason('boom'), 'failed');
});
