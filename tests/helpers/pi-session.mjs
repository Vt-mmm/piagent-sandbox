import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, sdk } from './world.mjs';

// Loads this package into a real Pi 1.4.0 session (no model, in memory) the way `pi -e <package>` does, and reports what Pi sees.
// The process moves into the project and takes a fake HOME: the extension reads both when it loads.
export async function loadInPi(world, { probe } = {}) {
  const agentDir = path.join(world.root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  process.env.HOME = world.home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.chdir(world.project);
  const seen = { tools: [], events: [] };
  const spy = pi => {
    for (const channel of ['piagent:tools.attest', 'piagent:permission.mode']) pi.events.on(channel, data => seen.events.push({ channel, data }));
    pi.on('session_start', () => { seen.tools = pi.getAllTools(); });
    probe?.(pi, seen);
  };
  const loader = new sdk.DefaultResourceLoader({ cwd: world.project, agentDir, noExtensions: true, additionalExtensionPaths: [REPO], extensionFactories: [spy] });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  const { session } = await sdk.createAgentSession({ cwd: world.project, agentDir, resourceLoader: loader,
    sessionManager: sdk.SessionManager.inMemory(), settingsManager: sdk.SettingsManager.inMemory() });
  await session.bindExtensions({});
  return { session, seen, errors, close: async () => { await session.dispose?.(); } };
}
