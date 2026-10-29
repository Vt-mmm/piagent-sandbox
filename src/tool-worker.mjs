import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { sandboxDiagnostic } from './sandbox-diagnostic.mjs';
import { fallbackFind, fallbackGrep } from './search-fallback.mjs';

// A dedicated, credential-free process already inside Seatbelt or bubblewrap. The launch profile and environment come
// from the trusted runtime, never the model. One request per line on stdin: {name, args, network?, model?}, or {cancel:true}.
const [sdkPath, cwd] = process.argv.slice(2);

// Linux: the command's network namespace reaches the package proxy only through the socket mounted at
// PIAGENT_PROXY_SOCKET; forward the proxy address the environment names (127.0.0.1:3128) to it.
const proxySocket = process.env.PIAGENT_PROXY_SOCKET;
if (proxySocket) {
  const net = await import('node:net');
  const forward = net.createServer(client => {
    const upstream = net.connect(proxySocket);
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.pipe(upstream); upstream.pipe(client);
  });
  forward.unref();
  await new Promise(resolve => { forward.once('error', resolve); forward.listen(3128, '127.0.0.1', resolve); });
  delete process.env.PIAGENT_PROXY_SOCKET;
}

const api = await import(pathToFileURL(sdkPath).href);
const factories = { read: api.createReadToolDefinition, write: api.createWriteToolDefinition, edit: api.createEditToolDefinition,
  bash: api.createBashToolDefinition, grep: api.createGrepToolDefinition, find: api.createFindToolDefinition, ls: api.createLsToolDefinition };
let active = false, controller, flags = {};
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const input = createInterface({ input: process.stdin });
const text = result => (result.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');

input.on('line', async line => {
  try {
    const message = JSON.parse(line);
    if (message.cancel === true) { controller?.abort(); return; }
    if (active || !Object.hasOwn(factories, message.name)) throw new Error('managed-worker-request-invalid');
    active = true; controller = new AbortController();
    flags = { network: message.network === true, isolated: message.isolated === true, docker: message.docker === true, engine: message.engine === true };
    const options = message.name === 'bash' ? { shellPath: '/bin/bash', exposeSessionEnvironment: false } : undefined;
    // The runtime copies ripgrep and fd into the sandbox home when the machine has them; else the built-in search.
    const provided = name => fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR ?? '', 'bin', name));
    const result = message.name === 'grep' && !provided('rg') ? fallbackGrep(cwd, message.args)
      : message.name === 'find' && !provided('fd') ? fallbackFind(cwd, message.args)
        : await factories[message.name](cwd, options).execute('managed-tool', message.args, controller.signal, update => emit({ update }), { cwd, model: message.model });
    // Successful output is returned verbatim; the note is only added to failures. Pi 1.x returns an isError
    // result for a denial or a non-zero exit instead of throwing: read it as the throw.
    if (result?.isError === true) throw new Error(text(result) || 'managed-worker-failed');
    emit({ result });
  } catch (error) { emit({ error: sandboxDiagnostic(error instanceof Error ? error.message : 'managed-worker-failed', flags) }); }
  finally { if (active) { input.close(); process.stdin.destroy(); } }
});
process.stdin.on('end', () => controller?.abort());
