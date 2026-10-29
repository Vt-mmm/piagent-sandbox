import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { credentialName } from './linux-sandbox.mjs';
import { runSafeGit } from './safe-git.mjs';

// What a turn's checkpoint sees of the project: the files git would list (tracked and untracked, .gitignore applied; a plain
// walk outside a repository), minus credential files, links, dependency folders and very large files. It reads and writes
// only files; the index, HEAD, refs and commits are never touched.
const SKIP = new Set(['.git', '.hg', '.svn', 'node_modules']);
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 20_000;

export function listProjectFiles(cwd, git = 'git') {
  let names;
  try {
    names = runSafeGit(git, cwd, ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    names = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(path.join(cwd, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !SKIP.has(entry.name)) walk(rel);
        else if (entry.isFile()) names.push(rel);
      }
    };
    walk('');
  }
  return names.filter(rel => !rel.split('/').some(part => SKIP.has(part)) && !credentialName(path.basename(rel), path.dirname(rel), [''])).slice(0, MAX_FILES);
}

const digest = data => createHash('sha256').update(data).digest('hex');

export class ProjectTree {
  constructor(cwd, { git = 'git' } = {}) { this.cwd = cwd; this.git = git; }
  // { path: { hash, mode } } of the project now. `keep(path, data)` receives each file's bytes (to store pre-images).
  snapshot(keep = null) {
    const files = new Map();
    for (const rel of listProjectFiles(this.cwd, this.git)) {
      const file = path.join(this.cwd, rel);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
        const data = fs.readFileSync(file), hash = digest(data);
        files.set(rel, { hash, mode: stat.mode & 0o777 });
        keep?.(hash, data);
      } catch { /* vanished or unreadable */ }
    }
    return files;
  }
  hashOf(rel) {
    try {
      const file = path.join(this.cwd, rel), stat = fs.lstatSync(file);
      return stat.isFile() ? digest(fs.readFileSync(file)) : null;
    } catch { return null; }
  }
  // Paths that changed between two snapshots: [{ path, before, after }] (null: absent).
  static changes(before, after) {
    const out = [];
    for (const rel of new Set([...before.keys(), ...after.keys()])) {
      const a = before.get(rel), b = after.get(rel);
      if (a?.hash !== b?.hash) out.push({ path: rel, before: a ?? null, after: b ?? null });
    }
    return out;
  }
  // Puts `data` (or removal) back at a project path; refuses a path that climbs out of the project or crosses a link.
  put(rel, data, mode = 0o644) {
    const file = path.resolve(this.cwd, rel);
    if (path.relative(this.cwd, file).startsWith('..') || path.isAbsolute(path.relative(this.cwd, file))) throw new Error('checkpoint-path-outside');
    let dir = path.dirname(file);
    while (dir !== this.cwd && !fs.existsSync(dir)) dir = path.dirname(dir);
    if (fs.realpathSync(dir) !== fs.realpathSync(this.cwd) && !fs.realpathSync(dir).startsWith(fs.realpathSync(this.cwd) + path.sep)) throw new Error('checkpoint-path-outside');
    if (data === null) { fs.rmSync(file, { force: true }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data, { mode });
  }
}
