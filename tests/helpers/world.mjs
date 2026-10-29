import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedToolBoundary } from '../../src/tool-boundary.mjs';

export const REPO = fileURLToPath(new URL('../..', import.meta.url));
export const SDK_ROOT = fs.realpathSync(path.join(REPO, 'node_modules/@earendil-works/pi-coding-agent'));
export const sdk = await import(path.join(SDK_ROOT, 'dist/index.js'));
export const darwin = process.platform === 'darwin';

// A throwaway world: a fake HOME (never the real one) holding synthetic credential files, and a project next to it. Nothing here
// touches the real ~/.ssh, Keychain, Agent Watch or ~/.pi.
export function makeWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-test-')));
  const home = path.join(root, 'home'), project = path.join(root, 'project'), outside = path.join(root, 'outside');
  const watch = process.platform === 'linux' ? path.join(home, '.local/share/agentwatch') : path.join(home, 'Library/Application Support/AgentWatch');
  const files = {
    ssh: path.join(home, '.ssh/id_rsa'), keychain: path.join(home, 'Library/Keychains/login.keychain-db'), watch: path.join(watch, 'binding.json'),
    homeNpmrc: path.join(home, '.npmrc'), env: path.join(project, '.env'), npmrc: path.join(project, '.npmrc'), outside: path.join(outside, 'note.txt'),
  };
  for (const file of [files.ssh, files.keychain, files.watch, files.homeNpmrc, files.env, files.npmrc, files.outside]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'SYNTHETIC-SECRET-VALUE\n');
  }
  fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the project\n');
  return { root, home, project, outside, files, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}

export function openBoundary(world, options = {}) {
  const boundary = new ManagedToolBoundary({ cwd: world.project, sdkRoot: SDK_ROOT, userHome: world.home, proxyPorts: [], identity: { name: 'Test', email: 'test@example.invalid' }, ...options });
  const tools = Object.fromEntries(boundary.tools(sdk).map(tool => [tool.name, tool]));
  const call = (name, args, signal) => tools[name].execute('test', args, signal, undefined, {});
  const text = result => result.content.map(part => part.text).join('\n');
  return { boundary, tools, call, text };
}

// What a tool call did: { ok, out } where out is the output or the error text.
export async function attempt(promise) {
  try { const result = await promise; return { ok: true, out: result.content.map(part => part.text).join('\n') }; }
  catch (error) { return { ok: false, out: String(error?.message ?? error) }; }
}
