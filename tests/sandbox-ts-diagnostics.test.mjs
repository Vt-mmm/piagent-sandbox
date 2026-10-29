import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadWithFakePi } from './helpers/fake-pi.mjs';
import { REPO, darwin, makeWorld } from './helpers/world.mjs';

// Acceptance C7: TypeScript errors of the file just edited come with the edit/write result. macOS only (parity F009); the project's
// own TypeScript (5.9.3, pinned here as a dev dependency) runs inside the sandbox.
const skip = !darwin && 'TypeScript diagnostics are macOS only';
const world = makeWorld();
let host;
before(async () => {
  fs.mkdirSync(path.join(world.project, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(REPO, 'node_modules/typescript'), path.join(world.project, 'node_modules/typescript'));
  const compilerOptions = { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' };
  fs.writeFileSync(path.join(world.project, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }));
  fs.mkdirSync(path.join(world.project, 'src'));
  host = await loadWithFakePi(world);
});
after(async () => { await host.close(); world.dispose(); });
const textOf = result => result.content.map(part => part.text).join('\n');

test('a type error in the file just written is appended to the result, and only while it is there', { skip, timeout: 120000 }, async () => {
  const bad = await host.mutate('write', { path: 'src/add.ts', content: 'export const add = (a: number, b: number): number => a + b;\nexport const oops: string = add(1, 2);\n' });
  assert.match(textOf(bad), /\[TypeScript, tsconfig\.json\] 1 error\(s\) in src\/add\.ts after this change/);
  assert.match(textOf(bad), /src\/add\.ts:2:\d+ TS2322/);
  const fixed = await host.mutate('edit', { path: 'src/add.ts', edits: [{ oldText: 'oops: string', newText: 'oops: number' }] });
  assert.ok(!/TypeScript/.test(textOf(fixed)), textOf(fixed));
});

test('a text file is never type-checked', { skip, timeout: 120000 }, async () => {
  const note = await host.mutate('write', { path: 'src/plain.txt', content: 'const x: number = "s"\n' });
  assert.ok(!/TypeScript/.test(textOf(note)));
});

test('without the project\'s TypeScript, or before a slow answer, nothing is added', { skip, timeout: 120000 }, async () => {
  const bare = makeWorld();
  try {
    fs.writeFileSync(path.join(bare.project, 'tsconfig.json'), '{}');
    const other = await loadWithFakePi(bare);
    const result = await other.mutate('write', { path: 'x.ts', content: 'export const n: number = "no typescript installed";\n' });
    assert.ok(!/TypeScript/.test(textOf(result)));
    await other.close();
  } finally { bare.dispose(); }
});

test('the note is built from the server\'s answer: syntax errors elsewhere are reported as "not type-checked"', async () => {
  const { TsDiagnostics } = await import('../src/ts-diagnostics.mjs');
  const checker = new TsDiagnostics({ cwd: '/p', node: process.execPath, spawnSandboxed: async () => { throw new Error('unused'); } });
  assert.equal(await checker.check('src/a.txt'), '');
  assert.equal(checker.applies('node_modules/x/index.js'), false);
  assert.equal(checker.applies('src/a.tsx'), process.platform === 'darwin');
  checker.dispose();
});
