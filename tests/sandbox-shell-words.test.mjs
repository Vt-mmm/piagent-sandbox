import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandSegments, stripWrapper } from '../src/shell-words.mjs';

const words = command => commandSegments(command).map(segment => segment.words.join(' '));

test('a command line is read as the simple commands it runs', () => {
  assert.deepEqual(words('cd api && git push; echo done | tee log'), ['cd api', 'git push', 'echo done', 'tee log']);
  assert.deepEqual(words("git commit -m 'a && b'"), ['git commit -m a && b']);
  assert.deepEqual(words('echo $(git push) done'), ['echo $SUB done', 'git push']);
  assert.deepEqual(words('echo `rm x`'), ['echo $SUB', 'rm x']);
  assert.deepEqual(words("bash -c 'git push && ls'"), ["bash -c git push && ls", 'git push', 'ls']);
  assert.deepEqual(words('if true; then git push; fi'), ['true', 'git push']);
  assert.deepEqual(words('(a; b) & c'), ['a', 'b', 'c']);
});

test('wrappers and assignments are stripped', () => {
  assert.deepEqual(stripWrapper(['env', 'A=1', '-i', 'nohup', 'git', 'push']), ['git', 'push']);
  assert.deepEqual(stripWrapper(['A=1', 'B=2', 'make']), ['make']);
  assert.deepEqual(stripWrapper(['command', '-v', 'git']), ['git']);
});

test('nesting stops at a depth, so a hostile line cannot loop the reader', () => {
  let command = 'git push';
  for (let i = 0; i < 20; i += 1) command = `bash -c '${command.replaceAll("'", '')}'`;
  assert.ok(commandSegments(command).length >= 1);
});
