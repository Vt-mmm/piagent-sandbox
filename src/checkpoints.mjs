import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectTree } from './checkpoint-git.mjs';

// /undo: the files the previous turn changed, deleted or created are put back; /undo again goes back one more turn.
// Refused while a turn runs and when the member changed a file again after the turn (nothing is touched then). Checkpoints
// live with the conversation (a private temporary folder, removed at the end), never block an edit and leave git alone.
const MAX_TURNS = 20;

export class TurnCheckpoints {
  #stack = []; #open = null; #tail = Promise.resolve(); #store;
  constructor(cwd, { busy = () => false, git = 'git' } = {}) {
    this.tree = new ProjectTree(cwd, { git });
    this.busy = busy;
    this.#store = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-undo-'));
  }
  #serial(task) {
    const next = this.#tail.then(task, task);
    this.#tail = next.then(() => {}, () => {});
    return next;
  }
  #blob(hash) { return path.join(this.#store, hash); }
  // Before the turn's first change: the project as it is. A failure only costs the turn its checkpoint.
  take(turn) {
    return this.#serial(async () => {
      if (this.#open?.turn === turn) return true;
      try {
        const before = this.tree.snapshot((hash, data) => { if (!fs.existsSync(this.#blob(hash))) fs.writeFileSync(this.#blob(hash), data, { mode: 0o600 }); });
        this.#open = { turn, before };
        return true;
      } catch { this.#open = null; return false; }
    });
  }
  // After the turn: what changed, kept on the stack if anything did.
  finish(turn) {
    return this.#serial(async () => {
      const open = this.#open;
      if (!open || open.turn !== turn) return null;
      this.#open = null;
      try {
        const changes = ProjectTree.changes(open.before, this.tree.snapshot());
        if (!changes.length) return null;
        this.#stack.push({ turn, changes });
        if (this.#stack.length > MAX_TURNS) this.#stack.shift();
        return changes.length;
      } catch { return null; }
    });
  }
  get depth() { return this.#stack.length; }
  undo() {
    return this.#serial(async () => {
      if (this.busy()) return { ok: false, reason: 'busy', message: 'Đang chạy một lượt: chờ lượt xong rồi /undo.' };
      const entry = this.#stack.at(-1);
      if (!entry) return { ok: false, reason: 'empty', message: 'Không có lượt nào để hoàn lại.' };
      const edited = entry.changes.filter(change => this.tree.hashOf(change.path) !== (change.after?.hash ?? null)).map(change => change.path);
      if (edited.length) {
        return { ok: false, reason: 'edited', files: edited, message: `Không hoàn lại: bạn đã sửa lại ${edited.slice(0, 5).join(', ')} sau lượt đó.` };
      }
      for (const change of entry.changes) {
        this.tree.put(change.path, change.before ? fs.readFileSync(this.#blob(change.before.hash)) : null, change.before?.mode);
      }
      this.#stack.pop();
      return { ok: true, files: entry.changes.map(change => change.path), message: `Đã hoàn lại ${entry.changes.length} file của lượt trước.` };
    });
  }
  async dispose() {
    await this.#tail;
    fs.rmSync(this.#store, { recursive: true, force: true });
    this.#stack = []; this.#open = null;
  }
}
