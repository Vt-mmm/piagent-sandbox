import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('entry point exports a default function', async () => {
  const mod = await import('../src/index.mjs');
  assert.equal(typeof mod.default, 'function');
});

test('package has no install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const hook of ['preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts?.[hook], undefined);
});
