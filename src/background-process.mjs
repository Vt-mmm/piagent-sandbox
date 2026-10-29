import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { redactedText } from './redact.mjs';

// Processes the agent keeps running across turns: a dev server, a watcher, a local service the tests need. A bash command
// stops after 10 minutes and what it leaves running stops when the turn ends; these run in the same sandbox, without
// network, until the agent stops them, the conversation closes or they reach their lifetime.
export const MAX_PROCESSES = 4;
export const LIFETIME_MS = 4 * 60 * 60 * 1000;
const BUFFER = 64 * 1024, MAX_WAIT_SECONDS = 60;
const realClock = { setTimeout: (...args) => setTimeout(...args), clearTimeout: handle => clearTimeout(handle), now: () => Date.now() };

export class BackgroundProcesses {
  #entries = new Map(); #next = 1;
  // `clock` lets tests drive the 4-hour lifetime without waiting.
  constructor(boundary, { lifetime = LIFETIME_MS, poll = 200, clock = realClock } = {}) { Object.assign(this, { boundary, lifetime, poll, clock }); }
  running() { return [...this.#entries.values()].filter(entry => entry.status === 'running'); }
  async start(command, name) {
    if (this.running().length >= MAX_PROCESSES) {
      throw new Error(`managed-process-limit: ${MAX_PROCESSES} background processes already run in this conversation `
        + `(${this.running().map(e => e.id).join(', ')}). Stop one with stop_process first.`);
    }
    const key = randomUUID(), id = `p${this.#next++}`;
    const { child, isolated } = await this.boundary.spawnBackground(command, key);
    const entry = { id, key, name: String(name || command).slice(0, 80), command, child, status: 'running', code: null, text: '', dropped: 0, read: 0, started: this.clock.now(), isolated };
    const append = chunk => {
      entry.text += chunk.toString('utf8');
      if (entry.text.length > BUFFER) { entry.dropped += entry.text.length - BUFFER; entry.text = entry.text.slice(-BUFFER); }
    };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.on('close', code => { if (entry.status === 'running') { entry.status = 'exited'; entry.code = code; } this.clock.clearTimeout(entry.timer); });
    child.on('error', () => { entry.status = 'exited'; entry.code = -1; });
    entry.timer = this.clock.setTimeout(() => this.stop(id, 'its 4-hour lifetime ended').catch(() => {}), this.lifetime);
    entry.timer?.unref?.();
    this.#entries.set(id, entry);
    return entry;
  }
  get(id) {
    const entry = this.#entries.get(String(id));
    if (!entry) throw new Error(`managed-process-unknown: no background process ${id} in this conversation${this.#entries.size ? ` (known: ${[...this.#entries.keys()].join(', ')})` : ''}.`);
    return entry;
  }
  // New output since the last read; waits up to `waitSeconds` for `until` to appear in it (a "ready" line) or for the process to end.
  async output(id, { waitSeconds = 0, until, signal } = {}) {
    const entry = this.get(id), deadline = Date.now() + Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS) * 1000;
    const fresh = () => entry.text.slice(Math.max(0, entry.read - entry.dropped));
    while (Date.now() < deadline && entry.status === 'running' && !signal?.aborted && !(until && fresh().includes(until))) {
      await new Promise(resolve => setTimeout(resolve, this.poll));
    }
    const skipped = Math.max(0, entry.dropped - entry.read), text = fresh();
    entry.read = entry.dropped + entry.text.length;
    return { entry, text: redactedText((skipped ? `[… ${skipped} characters not read …]\n` : '') + text), matched: until ? text.includes(until) : null };
  }
  async stop(id, reason = 'the agent stopped it') {
    const entry = this.get(id);
    if (entry.status !== 'running') return entry;
    entry.status = 'stopped'; entry.reason = reason;
    this.clock.clearTimeout(entry.timer);
    // Its process group and what it started (found by parent), then its marker.
    await stopProcessGroup(entry.child, () => this.boundary.stopBackground(entry.key));
    return entry;
  }
  async dispose() { await Promise.all(this.running().map(entry => this.stop(entry.id, 'the conversation closed'))); }
}

export async function stopProcessGroup(child, stopMarked = () => new Promise(resolve => setTimeout(resolve, 100))) {
  if (!Number.isInteger(child.pid) || child.pid <= 1 || child.exitCode != null || child.signalCode != null) return;
  const tree = descendants(child.pid);
  for (const pid of [-child.pid, ...tree]) try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  await stopMarked();
  for (const pid of [...tree, -child.pid]) try { process.kill(pid, 'SIGKILL'); } catch { /* stopped */ }
}

function descendants(root) {
  let rows = [];
  try { rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 }).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number)); }
  catch { return []; }
  const out = [], queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, ppid] of rows) if (ppid === parent && !out.includes(pid)) { out.push(pid); queue.push(pid); }
  }
  return out;
}

const describe = entry => `${entry.id} (${entry.name}): ${entry.status === 'running' ? `running for ${Math.round((Date.now() - entry.started) / 1000)} s`
  : entry.status === 'exited' ? `exited with code ${entry.code}` : `stopped (${entry.reason})`}`;
const result = text => ({ content: [{ type: 'text', text }], details: undefined });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });

// start_process, process_output and stop_process. macOS only: a Linux/WSL background sandbox is not built yet.
export function processTools(owner) {
  if (process.platform !== 'darwin') return [];
  const manager = () => (owner.boundary.background ??= new BackgroundProcesses(owner.boundary, owner.processOptions));
  return [
    { name: 'start_process', label: 'Start background process',
      description: 'Start a long-running command in the background and keep it running across turns: a dev server (npm run dev), a file watcher, a local service the tests call. '
        + 'It runs in the same sandbox as bash, without network, and keeps running until stop_process, the end of the conversation or 4 hours. '
        + 'Read its output with process_output (wait for a line such as "ready" there). Do not use it for tests or builds: run those with bash. At most 4 at once.',
      parameters: object({ command: { type: 'string', minLength: 1, maxLength: 4000 }, name: { type: 'string', minLength: 1, maxLength: 80 } }, ['command']),
      execute: async (_id, args) => {
        const entry = await manager().start(args.command, args.name);
        return result(`Started ${entry.id} (${entry.name}). It keeps running across turns; read its output with process_output and stop it with stop_process.`
          + `${entry.isolated ? ' A local proxy listens on this Mac, so other localhost servers are out of its reach.' : ''}`);
      } },
    { name: 'process_output', label: 'Background process output',
      description: 'Read what a background process started with start_process printed since the last read, and whether it still runs. '
        + 'wait_seconds (up to 60) waits for more output; with until, it returns as soon as that text appears (a server\'s ready line).',
      parameters: object({ id: { type: 'string', minLength: 1, maxLength: 20 }, wait_seconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS },
        until: { type: 'string', minLength: 1, maxLength: 200 } }, ['id']),
      execute: async (_id, args, signal) => {
        const { entry, text, matched } = await manager().output(args.id, { waitSeconds: args.wait_seconds, until: args.until, signal });
        return result(`${describe(entry)}${matched === false ? `; "${args.until}" has not appeared yet` : ''}\n${text || '(no new output)'}`);
      } },
    { name: 'stop_process', label: 'Stop background process', description: 'Stop a background process started with start_process, with everything it started.',
      parameters: object({ id: { type: 'string', minLength: 1, maxLength: 20 } }, ['id']),
      execute: async (_id, args) => result(describe(await manager().stop(args.id))) },
  ];
}
