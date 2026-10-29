import { SEATBELT_TERMINAL_RULES } from './seatbelt.mjs';
import { stopProcessGroup } from './background-process.mjs';

export { SEATBELT_TERMINAL_RULES };

// macOS: Seatbelt denies creating a PTY, so the host creates it and only the shell runs sandboxed, under the offline
// profile plus SEATBELT_TERMINAL_RULES. `pty` is the node-pty module (the caller owns that dependency; the package
// itself ships none). Returns a handle with `execute({kind:'input'|'resize'})` and `close()`.
export function seatbeltTerminal({ pty, profile, cwd, env, size, emit }) {
  const child = pty.spawn('/usr/bin/sandbox-exec', ['-p', `${profile}${SEATBELT_TERMINAL_RULES}`, '/bin/bash', '--noprofile', '--norc'],
    { cwd, env, cols: size.cols, rows: size.rows, name: 'xterm-256color' });
  const notify = message => { try { emit(message); } catch { /* the consumer never owns the process lifetime */ } };
  let exited = false, closing, resolveClosed;
  const completed = new Promise(resolve => { resolveClosed = resolve; });
  child.onData(text => {
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 8192, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1; // never split a surrogate pair
      notify({ kind: 'output', data: text.slice(start, end) });
      start = end;
    }
  });
  child.onExit(({ exitCode, signal }) => { exited = true; notify({ kind: 'exit', exitCode, signal: signal || null }); resolveClosed(); });
  const close = () => closing ??= (async () => {
    if (exited) return;
    await stopProcessGroup({ pid: child.pid, exitCode: null, signalCode: null });
    let timer;
    try { await Promise.race([completed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('managed-terminal-cleanup-unconfirmed')), 3000); })]); }
    finally { clearTimeout(timer); }
  })();
  return { completed, close, execute(payload) {
    if (exited || closing) return Promise.reject(Error('managed-terminal-exited'));
    if (payload.kind === 'input') child.write(payload.data); else child.resize(payload.cols, payload.rows);
    return Promise.resolve();
  } };
}
