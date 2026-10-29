import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { listProjectFiles, MAX_FILE_BYTES } from './checkpoint-git.mjs';
import { runSafeGit } from './safe-git.mjs';

// The patch a reviewer would see (diff against HEAD or a base commit, plus new files) as a digest, so a review knows whether it
// is still current, and the map of changed files, so a conversation answers for its own changes. Read-only git; no index writes.
const BASE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REF = /^[A-Za-z0-9._/~^@{}-]{1,200}$/;
const MAX_PATCH = 16 * 1024 * 1024;

function git(cwd, args, bin = 'git') {
  return runSafeGit(bin, cwd, args, { encoding: 'utf8', maxBuffer: MAX_PATCH + 1, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: '/nonexistent' } });
}

// The commit HEAD names now, or null (no repository, no commit yet).
export function readHead(cwd, bin) {
  try { const head = git(cwd, ['rev-parse', 'HEAD'], bin).trim(); return BASE.test(head) ? head : null; } catch { return null; }
}
// The commit a reference names when HEAD descends from it, or null.
export function resolveReviewBase(cwd, ref, bin) {
  if (typeof ref !== 'string' || !REF.test(ref) || ref.startsWith('-')) return null;
  try {
    const base = git(cwd, ['merge-base', 'HEAD', ref], bin).trim();
    return BASE.test(base) ? base : null;
  } catch { return null; }
}
function untracked(cwd, bin, scope) {
  return git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], bin).split('\0').filter(Boolean)
    .filter(rel => !scope || scope.has(rel)).map(rel => {
      const file = path.join(cwd, rel);
      let stat;
      try { stat = fs.lstatSync(file); } catch { return null; }
      if (stat.isSymbolicLink()) return { path: rel, mode: 'symlink', target: fs.readlinkSync(file) };
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { path: rel, mode: 'file', encoding: 'omitted', bytes: stat.size };
      return { path: rel, mode: 'file', encoding: 'base64', contents: fs.readFileSync(file).toString('base64') };
    }).filter(Boolean);
}
// { patch, untracked } as JSON text plus its sha256. `scope`: only these project-relative paths. `base`: the starting commit.
export function readPatchSnapshot(cwd, { scope = null, base = null, bin } = {}) {
  const from = typeof base === 'string' && BASE.test(base) ? base : 'HEAD';
  const diff = git(cwd, ['diff', '--binary', '--no-color', '--no-ext-diff', from, ...(scope ? ['--', ...scope] : [])], bin);
  const patch = JSON.stringify({ patch: diff, untracked: untracked(cwd, bin, scope), base: from === 'HEAD' ? null : from });
  if (Buffer.byteLength(patch) > MAX_PATCH) throw new Error('review-patch-limit');
  return { patch, digest: createHash('sha256').update(patch).digest('hex') };
}
export const readPatchDigest = (cwd, options) => readPatchSnapshot(cwd, options).digest;
// What each changed or new file holds now: Map of path → sha256. Compared before and after a command it names the files that command changed.
export function readChangedFiles(cwd, { bin } = {}) {
  const changed = new Set([...git(cwd, ['diff', '--name-only', '-z', 'HEAD'], bin).split('\0'), ...git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], bin).split('\0')]
    .filter(Boolean));
  const known = new Set(listProjectFiles(cwd, bin));
  const out = new Map();
  for (const rel of changed) {
    if (!known.has(rel)) continue;
    try { out.set(rel, createHash('sha256').update(fs.readFileSync(path.join(cwd, rel))).digest('hex')); } catch { out.set(rel, null); }
  }
  return out;
}
// A snapshot with nothing to review: no tracked change and no new file.
export function emptySnapshot(snapshot) {
  try { const value = JSON.parse(snapshot.patch); return !value.patch && !(value.untracked ?? []).length; } catch { return false; }
}
// Why a required review could not run, in one word for the member.
export function reviewUnavailableReason(message) {
  const text = String(message ?? '');
  if (/review-(patch|file|untracked)-limit|managed-review-patch-too-large/.test(text)) return 'too_large';
  if (/not a git repository|Could not access 'HEAD'|unknown revision|ambiguous argument 'HEAD'/i.test(text)) return 'not_git';
  return 'failed';
}
