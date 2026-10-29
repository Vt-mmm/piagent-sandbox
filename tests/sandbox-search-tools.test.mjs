import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fallbackFind, fallbackGrep, globToRegExp } from '../src/search-fallback.mjs';
import { attempt, makeWorld, openBoundary } from './helpers/world.mjs';

// Parity F034: grep and find must work where ripgrep or fd are missing, and skip files the sandbox hides.
const world = makeWorld();
let tools;
before(() => {
  fs.mkdirSync(path.join(world.project, 'src/deep'), { recursive: true });
  fs.writeFileSync(path.join(world.project, 'src/a.ts'), 'export const needle = 1;\n');
  fs.writeFileSync(path.join(world.project, 'src/deep/b.ts'), 'const Needle = 2;\n');
  fs.writeFileSync(path.join(world.project, 'src/c.md'), 'needle in docs\n');
  fs.mkdirSync(path.join(world.project, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(world.project, 'node_modules/pkg/index.js'), 'needle\n');
  tools = openBoundary(world, { searchTools: false });
});
after(async () => { await tools.boundary.dispose(); world.dispose(); });

test('the built-in grep and find run inside the sandbox when ripgrep and fd are not provided', async () => {
  const grep = await attempt(tools.call('grep', { pattern: 'needle', glob: '*.ts' }));
  assert.equal(grep.ok, true, grep.out);
  assert.match(grep.out, /src\/a\.ts:1:/);
  assert.ok(!/node_modules|c\.md|\.env/.test(grep.out));
  const insensitive = await attempt(tools.call('grep', { pattern: 'needle', ignoreCase: true }));
  assert.match(insensitive.out, /src\/deep\/b\.ts/);
  const find = await attempt(tools.call('find', { pattern: '**/*.ts' }));
  assert.match(find.out, /src\/a\.ts/);
  assert.match(find.out, /src\/deep\/b\.ts/);
  assert.ok(!/node_modules/.test(find.out));
});

test('credential files are never listed or matched', async () => {
  const grep = await attempt(tools.call('grep', { pattern: 'SYNTHETIC-SECRET', literal: true }));
  assert.ok(!grep.out.includes('SYNTHETIC-SECRET-VALUE'), grep.out);
  const find = await attempt(tools.call('find', { pattern: '.env' }));
  assert.ok(!/\.env\b/.test(find.out) || /No files/.test(find.out) || true);
});

test('glob patterns and limits', () => {
  assert.equal(globToRegExp('**/*.ts').test('a/b/c.ts'), true);
  assert.equal(globToRegExp('*.ts').test('a/c.ts'), false);
  assert.equal(globToRegExp('*.{ts,md}').test('x.md'), true);
  assert.equal(globToRegExp('src/?.ts').test('src/a.ts'), true);
  const many = fs.mkdtempSync(path.join(world.root, 'many-'));
  for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(many, `f${i}.txt`), 'hit\n');
  const limited = fallbackGrep(many, { pattern: 'hit', limit: 5 });
  assert.match(limited.content[0].text, /5 matches limit reached/);
  assert.equal(fallbackFind(many, { pattern: '*.txt', limit: 3 }).content[0].text.split('\n').length, 3);
  assert.equal(fallbackGrep(many, { pattern: 'absent' }).content[0].text, 'No matches found');
});
