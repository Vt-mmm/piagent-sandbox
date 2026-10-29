import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { developerLicense, developerTools, managedGit, searchToolPath, userToolchains } from './toolchain.mjs';
import { languageEnvironment } from './language-environment.mjs';
import { containerEngine, dockerCli, engineEnvironment } from './container-engine.mjs';
import { proxyEnvironment } from './package-proxy.mjs';
import { startBoundaryPackageProxy } from './boundary-package-proxy.mjs';
import { BWRAP, bubblewrapArgs, credentialFiles, referenceFolders } from './linux-sandbox.mjs';
import { inside, managedSeatbelt } from './seatbelt.mjs';
import { runSafeGit } from './safe-git.mjs';

export const PI_VERSION = '1.3.0';
export const TOOL_NAMES = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const workerPath = fileURLToPath(new URL('./tool-worker.mjs', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Without network a command still reaches servers on this Mac (a test's own server), unless a proxy listens here:
// the system's and the environment's proxies, and the usual ports of local proxy and VPN clients.
const LOCAL_PROXY_PORTS = [1080, 1087, 6152, 6153, 7890, 7891, 7897, 8118, 9050, 9150, 10808, 10809];
const loopbackHost = host => /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i.test(host);
function localProxyPorts() {
  const ports = new Set(LOCAL_PROXY_PORTS);
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const kind of ['HTTP', 'HTTPS', 'SOCKS']) {
      const host = new RegExp(`${kind}Proxy : (\\S+)`).exec(out)?.[1], port = Number(new RegExp(`${kind}Port : (\\d+)`).exec(out)?.[1]);
      if (host && loopbackHost(host) && port > 0 && port < 65536) ports.add(port);
    }
  } catch { /* no proxy settings */ }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    try { const url = new URL(process.env[name]); if (loopbackHost(url.hostname) && url.port) ports.add(Number(url.port)); } catch { /* unset */ }
  }
  return [...ports].sort((a, b) => a - b);
}
const proxyListening = ports => Promise.all(ports.map(port => new Promise(resolve => {
  const socket = net.connect({ host: '127.0.0.1', port });
  const done = value => { socket.destroy(); resolve(value); };
  socket.setTimeout(250, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
}))).then(answers => answers.some(Boolean));

// The git identity this project gets, as the user's own git would see it (name and email only), so commits work.
function gitIdentity(git, cwd, userHome) {
  const read = key => {
    try {
      return execFileSync(git, ['-C', cwd, 'config', '--get', key],
        { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: userHome, PATH: '/usr/bin:/bin' } }).trim();
    }
    catch { return ''; }
  };
  const name = read('user.name'), email = read('user.email');
  return name && email && name.length <= 200 && email.length <= 200 && !/[\x00-\x1f]/.test(name + email) ? { name, email } : null;
}
// The trusted runtime resolves the repository before any tool runs.
function repositoryRoots(git, cwd, temporary) {
  try {
    const [top, gitDir, commonDir] = runSafeGit(git, cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: temporary, PATH: '/usr/bin:/bin' } }).trim().split('\n');
    return { top: fs.realpathSync(top), gitDir: fs.realpathSync(gitDir), commonDir: fs.realpathSync(path.resolve(cwd, commonDir)) };
  } catch { return null; }
}
// Pi's grep/find need ripgrep and fd and would download them, which the sandbox forbids: copy installed binaries into the
// sandbox's agent dir; without them the worker falls back to the built-in search.
function provisionSearchTools(home, agentDir, userHome) {
  fs.writeFileSync(path.join(home, '.ripgreprc'), ['.env', '.env.*', '.env/**', 'auth.json', 'credentials', 'credentials.*', 'credentials/**', '.npmrc', '.netrc']
    .map(glob => `--glob=!${glob}`).join('\n') + '\n', { mode: 0o600 });
  const bin = path.join(agentDir, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const name of ['rg', 'fd']) {
    const source = searchToolPath(name, userHome);
    if (source) { fs.copyFileSync(source, path.join(bin, name)); fs.chmodSync(path.join(bin, name), 0o755); }
  }
}
function playwrightBrowsers(userHome) {
  const cache = process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright';
  try { const dir = fs.realpathSync(path.join(userHome, cache)); return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// Serializes tools that change the project; reads run side by side.
class Queue {
  #tail = Promise.resolve();
  run(name, task) {
    if (name === 'read' || name === 'grep' || name === 'find' || name === 'ls') return task();
    const next = this.#tail.then(task, task);
    this.#tail = next.then(() => {}, () => {});
    return next;
  }
  idle() { return this.#tail; }
}

export class ManagedToolBoundary {
  #queue = new Queue(); #children = new Set(); #closed = false;
  // readOnly: the project cannot be written; `commands`: bash is still offered (a helper that runs checks).
  // `userHome` is the member's home (tests pass a fake one). `proxy`: options for the package proxy (tests).
  constructor({ cwd, sdkRoot, protectedRoots = [], readOnly = false, commands = false, node = process.execPath, identity, userHome: home, searchTools = true,
    skills: skillFolders = [], proxyPorts, domainsFile = null, proxy = {} } = {}) {
    this.linux = process.platform === 'linux';
    if (process.platform !== 'darwin' && !(this.linux && BWRAP)) throw new Error('managed-sandbox-unavailable');
    this.cwd = fs.realpathSync(cwd);
    this.sdkRoot = fs.realpathSync(sdkRoot);
    this.node = fs.realpathSync(node);
    this.runtimeRoot = fs.realpathSync(path.dirname(workerPath));
    this.sdkPath = path.join(this.sdkRoot, 'dist/index.js');
    this.git = managedGit();
    this.domainsFile = domainsFile;
    if (JSON.parse(fs.readFileSync(path.join(this.sdkRoot, 'package.json'), 'utf8')).version !== PI_VERSION) throw new Error('managed-sdk-version-unqualified');
    const modules = ['sandbox-diagnostic.mjs', 'search-fallback.mjs'].map(name => path.join(this.runtimeRoot, name));
    this.pins = new Map([this.node, this.git, workerPath, ...modules, this.sdkPath].map(file => [file, hash(file)]));
    const userHome = fs.realpathSync(home ?? os.homedir());
    if ([userHome, '/', this.sdkRoot, this.runtimeRoot].includes(this.cwd) || [this.sdkRoot, this.runtimeRoot, this.node, this.git].some(p => inside(p, this.cwd))) {
      throw new Error('managed-project-overlaps-runtime');
    }
    this.temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-tools-')));
    fs.chmodSync(this.temporary, 0o700);
    this.home = path.join(this.temporary, 'home');
    fs.mkdirSync(this.home, { mode: 0o700 });
    this.agentDir = path.join(this.home, '.pi/agent');
    fs.mkdirSync(this.agentDir, { recursive: true, mode: 0o700 });
    this.userHome = userHome;
    const denied = [path.join(userHome, '.ssh'), path.join(userHome, '.aws'), path.join(userHome, '.config'), path.join(userHome, '.pi'), path.join(userHome, '.piagent'),
      path.join(userHome, '.codex'), path.join(userHome, '.claude'), path.join(userHome, 'Library/Keychains'), this.agentWatchDirectory(userHome),
      ...protectedRoots.map(p => path.resolve(p))];
    // An SDK installed under ~/.pi is granted as code only; the personal auth/config next to it stays closed.
    const narrowed = denied.filter(root => !inside(this.sdkRoot, root));
    if (inside(this.sdkRoot, path.join(userHome, '.pi'))) narrowed.push(path.join(userHome, '.pi/agent'));
    const repo = repositoryRoots(this.git, this.cwd, this.temporary);
    const allowedRoot = root => root !== '/' && !inside(userHome, root) && !inside(this.sdkRoot, root) && !inside(this.runtimeRoot, root);
    const repository = repo && repo.top !== this.cwd && allowedRoot(repo.top) ? [repo.top] : [];
    this.repositoryTop = repository[0] ?? this.cwd;
    // A repository above the home folder (a dotfiles repo) is never opened, nor writable through its git directory.
    const gitDirs = repo && (repo.top === this.cwd || allowedRoot(repo.top))
      ? [...new Set([repo.gitDir, repo.commonDir])].filter(dir => !inside(dir, this.cwd) && allowedRoot(dir)) : [];
    const skills = [...new Set(skillFolders.flatMap(dir => { try { return [fs.realpathSync(dir)]; } catch { return []; } }))]
      .filter(dir => dir !== '/' && !/[\x00-\x1f\x7f]/.test(dir) && !narrowed.some(root => inside(root, dir)) && !inside(userHome, dir));
    // Only approved commands get network; credentials stay denied, and so do reference folders.
    this.networkAllowed = !readOnly;
    this.scope = randomUUID(); // every process a command starts carries this marker, also a detached one
    this.setup = { narrowed, readOnly, repository, gitDirs, skills, identity: identity !== undefined ? identity : gitIdentity(this.git, this.cwd, userHome) };
    if (this.linux) {
      this.references = referenceFolders(userHome).filter(dir => !narrowed.some(root => inside(root, dir) || inside(dir, root)));
      this.empty = path.join(this.temporary, 'empty');
      fs.writeFileSync(this.empty, '', { mode: 0o400 });
      this.referenceCredentials = credentialFiles(this.references, { limit: 30_000 });
      this.projectCredentials = { at: 0, files: [] };
    } else {
      this.proxyPorts = proxyPorts ?? localProxyPorts();
      this.proxyCheck = { at: 0, listening: Promise.resolve(false) };
    }
    this.#configure();
    // Package registries without asking: commands that write the project reach them through the runtime's proxy.
    if (!readOnly) this.proxyReady = this.startProxy(proxy);
    if (searchTools) provisionSearchTools(this.home, this.agentDir, userHome);
    else fs.writeFileSync(path.join(this.home, '.ripgreprc'), '', { mode: 0o600 });
    this.allowed = readOnly ? TOOL_NAMES.filter(name => !['write', 'edit'].includes(name) && (name !== 'bash' || commands)) : [...TOOL_NAMES];
  }
  agentWatchDirectory(home) {
    return this.linux ? path.join(process.env.XDG_DATA_HOME || path.join(home, '.local/share'), 'agentwatch') : path.join(home, 'Library/Application Support/AgentWatch');
  }
  // What the machine offers commands: toolchains, the JDK, the Docker engine. Looked up again after the member installs
  // or starts something (run_on_host, start_docker), so the conversation sees it without a restart.
  #configure() {
    const { narrowed, readOnly, repository, gitDirs, skills, identity } = this.setup, userHome = this.userHome;
    const toolchains = userToolchains(userHome, this.node), developer = developerTools(), browsers = playwrightBrowsers(userHome);
    const languages = languageEnvironment({ userHome, repositoryTop: this.repositoryTop, home: this.home });
    this.languages = languages;
    this.engine = readOnly ? null : containerEngine({ userHome });
    this.dockerCli = readOnly ? null : this.engine?.cli ?? dockerCli();
    // The SDK's dependencies may be hoisted next to it (node_modules/@earendil-works/*).
    const hostRoot = this.sdkRoot.includes(`${path.sep}node_modules${path.sep}`) ? this.sdkRoot.slice(0, this.sdkRoot.lastIndexOf(`${path.sep}node_modules${path.sep}`) + 13) : this.sdkRoot;
    const base = this.base = { cwd: this.cwd, sdkRoot: hostRoot, runtimeRoot: this.runtimeRoot, temporary: this.temporary, node: this.node, denied: narrowed, readOnly,
      repository, gitDirs, toolchains: [...toolchains.roots, ...languages.readRoots], developer: developer.roots, browsers: browsers ? [browsers] : [], skills,
      caches: languages.writeRoots, license: developerLicense() };
    if (this.linux) this.linuxBase = { ...base, toolchains: [...base.toolchains, ...base.browsers], references: this.references, empty: this.empty, engineRoots: this.engine?.readRoots ?? [] };
    else {
      this.networkProfile = readOnly ? null : managedSeatbelt({ ...base, network: true });
      this.dockerProfile = this.engine ? managedSeatbelt({ ...base, network: true, docker: this.engine.socket, toolchains: [...base.toolchains, ...this.engine.readRoots] }) : null;
    }
    this.environment = this.#environment({ toolchains, developer, browsers, languages, identity });
    if (this.engine) this.environment.docker = { ...this.environment.network, ...engineEnvironment(this.engine, this.home) };
    this.#applyProxy();
  }
  #environment({ toolchains, developer, browsers, languages, identity }) {
    const PATH = [...new Set([languages.bin, path.dirname(this.node), ...toolchains.bins, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...developer.bins,
      path.dirname(this.git), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
    const locale = this.linux ? 'C.UTF-8' : 'en_US.UTF-8';
    const common = { ...toolchains.env, ...developer.env, PATH, HOME: this.home, TMPDIR: this.temporary, PIAGENT_TOOL_SCOPE: this.scope, LANG: locale, LC_ALL: locale,
      RIPGREP_CONFIG_PATH: path.join(this.home, '.ripgreprc'), PI_CODING_AGENT_DIR: this.agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}) };
    const playwright = browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {};
    return { network: { ...common, ...languages.env.network, ...playwright },
      offline: { ...common, ...languages.env.offline, ...playwright, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000', PIP_RETRIES: '0', PIP_TIMEOUT: '5' } };
  }
  // Plain commands' profile and environment, with the package proxy once it listens.
  #applyProxy() {
    const port = this.proxyUrl && !this.linux ? Number(new URL(this.proxyUrl).port) : null;
    if (!this.linux) {
      const proxy = port ? { proxyPort: port } : {};
      this.profile = managedSeatbelt({ ...this.base, references: this.userHome, ...proxy });
      this.isolatedProfile = managedSeatbelt({ ...this.base, references: this.userHome, loopback: false, ...proxy }); // while a local proxy listens
    }
    if (!this.proxyUrl) return;
    const offline = this.environment.offline;
    for (const key of ['npm_config_fetch_retries', 'npm_config_fetch_timeout', 'PIP_RETRIES', 'PIP_TIMEOUT']) delete offline[key];
    Object.assign(offline, proxyEnvironment(this.proxyUrl, { mavenOpts: offline.MAVEN_OPTS, gradleOpts: offline.GRADLE_OPTS, mavenHome: this.home }),
      { GOPROXY: this.languages.env.network.GOPROXY }, this.linux ? { PIAGENT_PROXY_SOCKET: '/run/piagent-proxy.sock' } : {});
  }
  refreshEnvironment() {
    if (!this.#closed) this.#configure();
    return Boolean(this.engine);
  }
  // Pi's own tool definitions, with `execute` replaced by the sandboxed call. Registered under the built-in names they replace Pi's.
  tools(api) {
    const factories = { read: api.createReadToolDefinition, write: api.createWriteToolDefinition, edit: api.createEditToolDefinition, bash: api.createBashToolDefinition,
      grep: api.createGrepToolDefinition, find: api.createFindToolDefinition, ls: api.createLsToolDefinition };
    return this.allowed.map(name => ({ ...factories[name](this.cwd),
      execute: (_id, args, signal, onUpdate, context) => this.invoke(name, args, signal, onUpdate, context?.model) }));
  }
  startProxy(options) { return startBoundaryPackageProxy(this, () => this.#applyProxy(), options); }
  invoke(name, args, signal, onUpdate, model, options = {}) {
    return this.#queue.run(name, () => this.#queuedInvoke(name, args, signal, onUpdate, model, options));
  }
  async #queuedInvoke(name, args, signal, onUpdate, model, { network = false, docker = false } = {}) {
    await this.proxyReady;
    const before = this.proxy?.deniedCount ?? 0;
    try { return await this.#invoke(name, args, signal, onUpdate, model, { network, docker }); }
    catch (error) {
      // A command that failed after the proxy refused a host: name the hosts.
      const refused = !network && !docker && this.proxy ? this.proxy.deniedSince(before) : [];
      if (!refused.length) throw error;
      throw new Error(`managed-domain-blocked: Lệnh thường chỉ tải được từ các registry package quen thuộc (npm, PyPI, Go, crates.io, Maven, Gradle, NuGet, `
        + `RubyGems, Packagist, pub.dev…) và tải về public từ GitHub. Host bị chặn: ${refused.join(', ')}. `
        + `Nếu lệnh thật sự cần host này, dùng run_with_network để người dùng duyệt đúng lệnh đó.\n${String(error?.message ?? error)}`);
    }
  }
  #checkPins() {
    for (const [file, digest] of this.pins) if (hash(file) !== digest) throw new Error('managed-runtime-changed');
  }
  async #isolated() {
    if (this.linux) return false;
    if (Date.now() - this.proxyCheck.at > 5000) this.proxyCheck = { at: Date.now(), listening: proxyListening(this.proxyPorts) };
    return this.proxyCheck.listening;
  }
  async #invoke(name, args, signal, onUpdate, model, { network, docker }) {
    if (docker && !this.engine) throw new Error('managed-tool-unavailable');
    network ||= docker;
    if (this.#closed || !this.allowed.includes(name) || (network && (name !== 'bash' || !this.networkAllowed))) throw new Error('managed-tool-unavailable');
    if (signal?.aborted) throw new Error('managed-tool-cancelled');
    this.#checkPins();
    // `~` (as in an @~/… mention) is the member's home folder: the sandbox's own HOME is an empty private folder.
    if (name !== 'bash' && typeof args?.path === 'string' && /^@?~(\/|$)/.test(args.path)) args = { ...args, path: this.userHome + args.path.replace(/^@?~/, '') };
    const isolated = !network && await this.#isolated();
    const message = JSON.stringify({ name, args, ...(network ? { network: true } : {}), ...(isolated ? { isolated: true } : {}),
      ...(docker ? { docker: true } : this.engine ? { engine: true } : {}), model: model ? { input: model.input, inputLimits: model.inputLimits } : undefined }) + '\n';
    if (Buffer.byteLength(message) > MAX_WIRE_BYTES) throw new Error('managed-tool-input-too-large');
    return await new Promise((resolve, reject) => {
      const [sandbox, sandboxArgs] = this.linux ? [BWRAP, this.bubblewrap(network, docker)]
        : ['/usr/bin/sandbox-exec', ['-p', docker ? this.dockerProfile : network ? this.networkProfile : isolated ? this.isolatedProfile : this.profile]];
      const child = spawn(sandbox, [...sandboxArgs, this.node, workerPath, this.sdkPath, this.cwd], { cwd: this.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: docker ? this.environment.docker : network ? this.environment.network : this.environment.offline });
      this.#children.add(child);
      const decoder = new StringDecoder('utf8');
      let pending = '', bytes = 0, result, failure, terminated = false, hardStop;
      const terminate = () => {
        if (terminated) return;
        terminated = true;
        child.stdin.write('{"cancel":true}\n');
        // bash descendants may use separate process groups: native abort first, a hard stop is the last resort.
        hardStop = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 1000);
        hardStop.unref();
      };
      const abort = () => { failure = new Error('managed-tool-cancelled'); terminate(); };
      child.managedCancel = abort;
      // A command stops at its own timeout (at most 30 minutes), else after 10 minutes; other tools after 30 s.
      const seconds = Math.min(Math.max(Number(args?.timeout) || 600, 1), 1800);
      const deadline = setTimeout(() => { failure = new Error('managed-tool-timeout'); terminate(); }, name === 'bash' ? seconds * 1000 + 5000 : 30000);
      deadline.unref();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        // The cap is per message, not per command: a noisy command streams a progress update every 100 ms.
        const newline = chunk.lastIndexOf(10);
        bytes = newline < 0 ? bytes + chunk.length : chunk.length - newline - 1;
        if (bytes > MAX_WIRE_BYTES) { failure = new Error('managed-tool-output-too-large'); terminate(); return; }
        pending += decoder.write(chunk);
        for (;;) {
          const end = pending.indexOf('\n');
          if (end < 0) break;
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value.update) onUpdate?.(value.update);
            else if (value.error) failure ??= new Error(String(value.error).slice(0, 1000)); // a cancel asked for first stays the reason
            else if (value.result) result = value.result;
            else throw new Error('managed-worker-invalid-response');
          } catch { failure = new Error('managed-worker-invalid-response'); terminate(); }
        }
      });
      child.stderr.on('data', () => {}); // raw startup diagnostics (paths, env) never reach the model
      child.on('error', () => { failure = new Error('managed-worker-start-failed'); });
      child.on('close', code => {
        clearTimeout(deadline);
        if (hardStop) clearTimeout(hardStop);
        this.#children.delete(child);
        signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result || pending) reject(new Error('managed-worker-failed'));
        else resolve(result);
      });
      child.stdin.write(message);
      if (signal?.aborted) abort();
    });
  }
  // bubblewrap arguments for one command; credential files of the project are looked for again every 15 seconds.
  bubblewrap(network, docker = false) {
    if (Date.now() - this.projectCredentials.at > 15_000) this.projectCredentials = { at: Date.now(), files: credentialFiles([this.cwd, ...this.linuxBase.repository]) };
    const credentials = [...this.projectCredentials.files, ...(network ? [] : this.referenceCredentials)];
    const { engineRoots, ...base } = this.linuxBase;
    return bubblewrapArgs({ ...base, references: network ? [] : base.references, network, credentials, proxySocket: network ? null : this.proxySocket,
      ...(docker ? { docker: this.engine.socket, toolchains: [...base.toolchains, ...engineRoots] } : {}) });
  }
  // Processes a command left running (`nohup … &`) outlive it with the marker in their environment: stopped when a turn ends
  // and when the boundary closes. On Linux a command's processes end with it (its own PID namespace).
  async stopStrays() {
    if (this.#children.size || this.linux) return 0;
    return stopMarked(`PIAGENT_TOOL_SCOPE=${this.scope}`);
  }
  // A process the agent keeps running across turns (background-process.mjs): the plain command sandbox, marked as this
  // conversation's background process instead of the turn's, so stopStrays leaves it. `stdin` 'pipe' for a process that answers requests.
  async spawnSandboxed(argv, key, { stdin = 'ignore' } = {}) {
    if (this.#closed || this.linux || !this.allowed.includes('bash') || !/^[0-9a-f-]{36}$/.test(key)) throw new Error('managed-tool-unavailable');
    this.#checkPins();
    const isolated = await this.#isolated(), { PIAGENT_TOOL_SCOPE: _turn, ...env } = this.environment.offline;
    const child = spawn('/usr/bin/sandbox-exec', ['-p', isolated ? this.isolatedProfile : this.profile, ...argv],
      { cwd: this.cwd, detached: true, stdio: [stdin, 'pipe', 'pipe'], env: { ...env, PIAGENT_PROCESS_SCOPE: `${this.scope}:${key}` } });
    return { child, isolated };
  }
  spawnBackground(command, key) { return this.spawnSandboxed(['/bin/bash', '-c', command], key); }
  stopBackground(key) { return stopMarked(`PIAGENT_PROCESS_SCOPE=${this.scope}:${key}`); }
  async dispose() {
    this.#closed = true;
    const stopping = [...this.#children].map(child => new Promise(resolve => { child.once('close', resolve); child.managedCancel(); }));
    await Promise.all(stopping);
    await this.#queue.idle();
    await this.background?.dispose();
    await this.stopStrays();
    if (!this.linux) await stopMarked(`PIAGENT_PROCESS_SCOPE=${this.scope}:`);
    await this.proxyReady;
    await this.proxy?.close().catch(() => {});
    if (this.proxySocket) fs.rmSync(this.proxySocket, { force: true });
    fs.rmSync(this.temporary, { recursive: true, force: true });
  }
}

// Stops every process whose environment carries `marker` (ps -E), then whatever is left after two seconds.
export async function stopMarked(marker) {
  const find = () => {
    try {
      return execFileSync('/bin/ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 5000 }).split('\n')
        .filter(row => row.includes(marker)).map(row => Number(row.trim().split(/\s+/)[0])).filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    } catch { return []; }
  };
  const found = find();
  for (const pid of found) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  for (let waited = 0; found.length && waited < 2000; waited += 100) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!find().length) break;
  }
  for (const pid of find()) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  return found.length;
}
