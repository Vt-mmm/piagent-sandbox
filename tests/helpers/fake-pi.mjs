import { createSandbox } from '../../src/index.mjs';
import { SDK_ROOT } from './world.mjs';

// The slice of Pi's extension API this package uses, recording registrations and letting a test fire events by name.
export function fakePi() {
  const handlers = {}, listeners = {}, commands = {}, tools = [], entries = [], emitted = [];
  const pi = {
    events: { emit: (channel, data) => { emitted.push({ channel, data }); for (const listener of listeners[channel] ?? []) listener(data); },
      on: (channel, listener) => { (listeners[channel] ??= []).push(listener); return () => {}; } },
    on: (name, handler) => { (handlers[name] ??= []).push(handler); },
    registerTool: tool => tools.push(tool),
    registerCommand: (name, options) => { commands[name] = options; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  };
  const fire = async (name, event, ctx) => {
    const results = [];
    for (const handler of handlers[name] ?? []) results.push(await handler(event, ctx));
    return results.filter(result => result !== undefined);
  };
  return { pi, fire, commands, tools, entries, emitted, handlers };
}
export function fakeUi(answers = []) {
  const notes = [], asked = [];
  const ui = { notify: (message, type) => notes.push({ message, type }), confirm: async (title, body) => { asked.push({ title, body }); return answers.length ? answers.shift() : true; } };
  return { ui, notes, asked };
}

// The package loaded against a fake Pi, in `world`'s project, with the fake HOME.
export async function loadWithFakePi(world, options = {}) {
  const host = fakePi();
  const sandbox = await createSandbox(host.pi, { cwd: world.project, sdkRoot: SDK_ROOT, userHome: world.home, boundary: { proxyPorts: [] }, ...options });
  const ui = fakeUi(options.answers);
  const ctx = { ui: ui.ui, cwd: world.project, signal: undefined, sessionManager: { getEntries: () => host.entries } };
  await host.fire('session_start', {}, ctx);
  const tool = name => host.tools.find(item => item.name === name);
  const call = (name, args) => tool(name).execute('id', args, undefined, undefined, ctx);
  // One member message: the agent runs `body`, then settles.
  const turn = async body => {
    await host.fire('before_agent_start', { messageType: 'user' }, ctx);
    try { await body(); } finally { await host.fire('agent_end', {}, ctx); await host.fire('agent_settled', {}, ctx); }
  };
  const mutate = async (name, args) => {
    await host.fire('tool_call', { toolName: name, input: args }, ctx);
    const result = await call(name, args);
    const [changed] = await host.fire('tool_result', { toolName: name, input: args, content: result.content, isError: false }, ctx);
    return changed ?? result;
  };
  return { ...host, sandbox, ctx, ui, tool, call, turn, mutate, close: () => host.fire('session_shutdown', {}, ctx) };
}
