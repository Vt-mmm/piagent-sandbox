import { Approvals } from '../../src/approval.mjs';
import { Permission } from '../../src/permission.mjs';

// A boundary that records what it was asked to run, a ctx whose confirm prompt answers from a script, and the owner they share.
export function fakeOwner({ mode = 'ask', engine = null, allowBypass = true } = {}) {
  const permission = new Permission();
  permission.allowBypass(allowBypass);
  if (mode !== 'ask') permission.set(mode);
  const invoked = [];
  const boundary = { userHome: '/tmp/fake-home', engine, dockerCli: engine?.cli ?? null, temporary: '/tmp/fake-tmp', refreshed: 0,
    invoke: async (name, args, _signal, _onUpdate, _model, options) => { invoked.push({ name, args, options }); return { content: [{ type: 'text', text: 'ran' }] }; },
    refreshEnvironment() { this.refreshed += 1; return Boolean(this.engine); } };
  return { owner: { boundary, cwd: '/tmp/fake-project', permission, approvals: new Approvals(), hosts: new Set() }, invoked, boundary };
}
export function fakeCtx(answers = []) {
  const asked = [];
  return { asked, ui: { confirm: async (title, body) => { asked.push({ title, body }); return answers.length ? answers.shift() : true; } } };
}
export const byName = (tools, name) => tools.find(tool => tool.name === name);
