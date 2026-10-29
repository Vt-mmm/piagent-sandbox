import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Approvals } from './approval.mjs';
import { ManagedToolBoundary } from './tool-boundary.mjs';
import { Permission, ENTRY } from './permission.mjs';
import { commandTools } from './command-tools.mjs';
import { fetchOriginTool } from './fetch-origin.mjs';
import { processTools } from './background-process.mjs';
import { TurnCheckpoints } from './checkpoints.mjs';
import { TsDiagnostics } from './ts-diagnostics.mjs';
import { guardFetch } from './fetch-guard.mjs';
import { mcpWriteAction } from './handoff-policy.mjs';
import { redactedText } from './redact.mjs';

// piagent-sandbox: the sandboxed tools of Piagent company mode on stock Pi. Registering `bash`, `read`, `edit`, `write`, `grep`,
// `find` and `ls` under their built-in names replaces Pi's own; every call then runs in a fresh Seatbelt (macOS) or bubblewrap
// (Linux, WSL2) worker. Other packages are reached only through the Pi event bus (docs/package-contract.md in piagent-bundle):
//   piagent:tools.attest    sandbox → harness  { v, tools: [{ name, source }] }
//   piagent:permission.mode sandbox → harness  { v, mode: 'ask' | 'full' | 'bypass' }
//   piagent:run.state       provider → harness (also read here)  { v, harness: { bypassMode } } allows Bypass
//   piagent:tools.child     harness → sandbox  { v, readOnly: true, commands, web, key, reply } → reply({ ok, tools }) read-only tools for a helper
//   piagent:tools.child.close  harness → sandbox  { v, key }
export const SOURCE = 'piagent-sandbox';
const CONTRACT = 1;
const MUTATING = new Set(['edit', 'write', 'bash']);

async function loadSdk(root) {
  const entry = root ? path.join(root, 'dist/index.js') : fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const sdkRoot = root ?? path.dirname(path.dirname(entry));
  return { api: await import(entry), sdkRoot: fs.realpathSync(sdkRoot) };
}

// Options are for tests and for a bundle that wants a different folder; the default export uses the defaults.
export async function createSandbox(pi, { cwd = process.cwd(), sdkRoot, userHome, domainsFile, boundary: boundaryOptions = {}, deps = {} } = {}) {
  const { api, sdkRoot: root } = await loadSdk(sdkRoot);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: root, userHome, domainsFile: domainsFile ?? process.env.PIAGENT_SANDBOX_DOMAINS ?? (agentDir && path.join(agentDir, 'sandbox-domains')),
    referencesFile: process.env.PIAGENT_SANDBOX_REFERENCES ?? (agentDir && path.join(agentDir, 'sandbox-references')),
    ...boundaryOptions });
  const permission = new Permission({ persist: data => pi.appendEntry(ENTRY, data), onChange: mode => pi.events.emit('piagent:permission.mode', { v: CONTRACT, mode }) });
  const approvals = new Approvals();
  let turn = 0, running = false;
  const checkpoints = new TurnCheckpoints(boundary.cwd, { busy: () => running, git: boundary.git });
  const ts = new TsDiagnostics(boundary);
  const owner = { boundary, cwd: boundary.cwd, permission, approvals, checkpoints, hosts: new Set(), turn: () => turn, processOptions: deps.processOptions };

  const tools = [...boundary.tools(api), ...commandTools(owner, deps.commands), fetchOriginTool(owner, deps.fetchOrigin), ...processTools(owner)];
  for (const tool of tools) pi.registerTool(tool);
  const attest = () => pi.events.emit('piagent:tools.attest', { v: CONTRACT, tools: tools.map(tool => ({ name: tool.name, source: SOURCE })) });

  // Helpers get read, grep, find, ls (and bash without network when `commands`) on a read-only boundary of their own; never edit or write.
  const children = new Map();
  const closeChild = async key => { const child = children.get(key); children.delete(key); await child?.dispose(); };
  pi.events.on('piagent:tools.child', async request => {
    const reply = typeof request?.reply === 'function' ? request.reply : () => {};
    try {
      if (request.readOnly !== true || typeof request.key !== 'string') throw new Error('managed-tools-child-invalid');
      await closeChild(request.key);
      const child = new ManagedToolBoundary({ cwd, sdkRoot: root, userHome, readOnly: true, commands: request.commands === true, ...boundaryOptions });
      children.set(request.key, child);
      reply({ v: CONTRACT, ok: true, tools: child.tools(api) });
    } catch (error) { reply({ v: CONTRACT, ok: false, error: String(error?.message ?? error) }); }
  });
  pi.events.on('piagent:tools.child.close', request => { if (typeof request?.key === 'string') closeChild(request.key); });
  pi.events.on('piagent:run.state', state => permission.allowBypass(state?.harness?.bypassMode === true));
  pi.on('session_start', (_event, ctx) => { permission.restore(ctx.sessionManager.getEntries()); attest(); });
  pi.on('before_agent_start', event => { if (event.messageType === 'user') turn += 1; running = true; attest(); });
  pi.on('agent_settled', async () => { running = false; await boundary.stopStrays(); });
  pi.on('agent_end', async () => { await checkpoints.finish(turn); });

  // A change to the project gets its checkpoint first; a failure only costs the turn its checkpoint.
  pi.on('tool_call', async (event, ctx) => {
    if (MUTATING.has(event.toolName)) await checkpoints.take(turn);
    if (event.toolName === 'web_fetch') {
      try { await guardFetch(owner, 'main', event.input?.url, ctx, ctx.signal); } catch (error) { return { block: true, reason: error.message }; }
    }
    // An MCP tool that writes to the system behind its server is asked about in every mode (a handoff).
    const verb = /^mcp[_.:-]/.test(event.toolName) ? mcpWriteAction(event.toolName) : null;
    if (verb) {
      try {
        await approvals.request(ctx, { key: `${event.toolName} ${JSON.stringify(event.input)}`, title: 'Công cụ MCP ghi ra ngoài',
          body: `${event.toolName} (${verb}) ghi vào hệ thống bên ngoài.\n\nĐồng ý: chạy một lần.\nTừ chối: không chạy, agent được báo bạn đã từ chối.` }, ctx.signal);
      } catch (error) { return { block: true, reason: error.message }; }
    }
    return undefined;
  });

  // Secrets leave tool output; TypeScript errors of a file just written come with the result.
  pi.on('tool_result', async event => {
    const content = (event.content ?? []).map(part => (part.type === 'text' ? { ...part, text: redactedText(part.text) } : part));
    let note = '';
    if (!event.isError && (event.toolName === 'edit' || event.toolName === 'write')) note = await ts.check(event.input?.path);
    const changed = note || content.some((part, i) => part.text !== event.content[i].text);
    if (!changed) return undefined;
    return { content: note ? [...content, { type: 'text', text: note }] : content, ...(event.structuredContent ? { structuredContent: event.structuredContent } : {}) };
  });

  // `!` and `!!` commands of the member run in the sandbox too, not on the host.
  pi.on('user_bash', () => ({ operations: { exec: async (command, _cwd, { onData, signal, timeout }) => {
    try {
      const result = await boundary.invoke('bash', { command, ...(timeout ? { timeout } : {}) }, signal);
      onData(Buffer.from((result.content ?? []).map(part => part.text ?? '').join('\n') + '\n'));
      return { exitCode: 0 };
    } catch (error) {
      const message = String(error?.message ?? error);
      onData(Buffer.from(`${message}\n`));
      return { exitCode: Number(/exited with code (\d+)/.exec(message)?.[1] ?? 1) };
    }
  } } }));

  pi.registerCommand('undo', { description: 'Hoàn lại các file lượt trước đã sửa', handler: async (_args, ctx) => {
    const result = await checkpoints.undo();
    ctx.ui.notify(result.message, result.ok ? 'info' : 'warning');
  } });
  pi.registerCommand('bypass', { description: 'Mức quyền: on, full, off, status', handler: async (args, ctx) => {
    const word = String(args ?? '').trim().toLowerCase() || 'status';
    const names = { ask: 'Ask first', full: 'Full access', bypass: 'Bypass' };
    try {
      if (word === 'status') { ctx.ui.notify(`Mức quyền: ${names[permission.mode]}${permission.bypassAllowed ? '' : ' (Bypass chưa được Harness cho phép)'}`, 'info'); return; }
      if (word === 'on') {
        if (!permission.bypassAllowed) throw new Error('managed-bypass-unavailable');
        if (!await ctx.ui.confirm('Bật Bypass', 'Bypass chạy lệnh không hỏi; push, PR, publish, deploy và run_on_host vẫn hỏi.\n\nĐồng ý: bật Bypass.')) return;
        permission.set('bypass');
      } else if (word === 'full') permission.set('full');
      else if (word === 'off') permission.set('ask');
      else throw new Error('Dùng: /bypass on, full, off, status');
      ctx.ui.notify(`Mức quyền: ${names[permission.mode]}`, 'info');
    } catch (error) { ctx.ui.notify(error.message, 'warning'); }
  } });

  pi.on('session_shutdown', async () => {
    approvals.forget();
    ts.dispose();
    await checkpoints.dispose();
    await Promise.all([...children.keys()].map(closeChild));
    await boundary.dispose();
  });
  return { boundary, permission, approvals, checkpoints, tools, owner };
}

export default async function piagentSandbox(pi) { await createSandbox(pi); }
