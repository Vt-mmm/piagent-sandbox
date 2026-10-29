import { spawn } from 'node:child_process';
import { engineAlive, engineLauncher } from './container-engine.mjs';
import { MEMBER_ONLY, credentialReason, memberOnlyReason, runHostCommand } from './host-command.mjs';
import { handoffReason } from './handoff-policy.mjs';
import { detachedEmulator, runsProjectCode, simulatorCommandReason } from './simulator-commands.mjs';

// Commands that leave the plain sandbox: run_with_network (internet, a local server or browser), run_with_docker when this
// machine has Docker, run_on_host (the member's machine, outside the sandbox) and run_on_simulator. What each mode asks:
// - Ask first: every command.
// - Full access and Bypass: run_with_network, run_with_docker and run_on_host ask every command (a command with the internet can send the
//   project out; a container can mount any shared folder). run_on_simulator runs simctl, adb and emulator commands, and asks when
//   the command runs a script of the project (xcodebuild, gradlew, pod, flutter, npx, ./tool): that script is code the agent can write.
const PARAMETERS = { type: 'object', additionalProperties: false, required: ['command', 'reason'], properties: {
  command: { type: 'string', minLength: 1, maxLength: 4000 }, reason: { type: 'string', minLength: 1, maxLength: 300 }, timeout: { type: 'number', minimum: 1, maximum: 1800 } } };

const KINDS = {
  network: { name: 'run_with_network', label: 'Run with network', riskClass: 'medium', title: 'Chạy lệnh có internet',
    description: 'Run one shell command that needs the internet beyond the package registries bash already reaches (a download site or registry the package proxy refuses), '
      + 'or that starts a local server or a browser (end-to-end tests with Playwright\'s Chromium against a server on 127.0.0.1), after the user approves that exact command '
      + '(every mode asks, Bypass included: with the internet a command could send the project out). Normal bash has no internet. '
      + 'Credentials (.npmrc, SSH keys, Keychain) stay unavailable, so private registries and git push are not possible here.',
    allowText: 'chạy đúng lệnh này một lần, có internet; server nó mở nhận kết nối trong lúc chạy.',
    confirm: owner => alwaysAsk(owner, 'with the internet a command can send the project out') },
  docker: { name: 'run_with_docker', label: 'Run with Docker', riskClass: 'high', title: 'Chạy lệnh dùng Docker',
    description: 'Run one shell command that needs the Docker engine of this machine: docker, docker compose (a database or service for tests), docker build, or tests that '
      + 'start containers themselves (Testcontainers), after the user approves that exact command (every mode asks, Bypass included: a container can mount any folder Docker shares). '
      + 'It has internet access too. Mount only folders inside the project. Registry credentials are unavailable. '
      + 'Containers started in the background (-d, compose up -d) keep running after the command: stop them when the work is done unless the member wants them kept.',
    allowText: 'chạy đúng lệnh này một lần, có internet và Docker; container nó tạo có thể đọc thư mục Docker được chia sẻ trên máy và có thể tiếp tục chạy.',
    confirm: owner => alwaysAsk(owner, 'a container can mount and change any folder Docker shares') },
  host: { name: 'run_on_host', label: 'Run on this machine', riskClass: 'high', title: 'Chạy lệnh trên máy (ngoài sandbox)',
    description: 'Run one shell command on the member\'s machine, outside the sandbox, as the member, after they approve that exact command (every mode asks, Bypass included; a push, PR, publish, '
      + 'deploy or a command that reaches credentials says why on the card). Use it when the sandbox blocks what the task needs and no other tool covers it: '
      + 'install a runtime or tool the project needs (brew install openjdk@21…), git pull with the member\'s sign-in, git push only when the member asked for it, a private registry, '
      + 'a file outside the project. It has the member\'s files, Keychain and sign-ins, so ask only for what the task needs and say why in reason. No input can be typed: '
      + 'commands that need the member\'s password (sudo, a .pkg installer) or an interactive sign-in are refused; ask the member for those.',
    allowText: 'chạy đúng lệnh này một lần trên máy bạn, ngoài sandbox, bằng quyền của bạn: lệnh đọc/sửa được file và dùng được tài khoản đã đăng nhập trên máy.',
    // The member approves every command, Bypass included (plan: the machine itself is outside the sandbox). When Full access or Bypass
    // would also ask on its own, the card says why.
    confirm: (owner, command) => (owner.permission.asksOnlyHandoff ? credentialReason(command) ?? handoffReason(command) : owner.permission.confirmation(command)) ?? 'ask' },
  simulator: { name: 'run_on_simulator', label: 'Run on simulator', riskClass: 'medium', title: 'Chạy lệnh simulator',
    description: 'Run one iOS Simulator or Android emulator command on the member\'s machine, outside the sandbox. iOS: xcrun simctl (list, boot, bootstatus -b, install, launch, '
      + 'terminate, openurl, io <device> screenshot <file>, ui appearance, status_bar, spawn <device> log show…), xcodebuild with a simulator destination, xcodegen generate, axe, '
      + 'open -a Simulator. Android: adb, emulator -avd <name> (started in the background), avdmanager, ./gradlew installDebug. Also flutter, pod install, npx expo/react-native/cap '
      + '(build commands that run a script of the project are asked about in every mode), '
      + 'mkdir -p and cd inside the project. Parts may be joined by && or || and piped into grep, head, tail, xcbeautify or jq; files may be written only inside the project or to /dev/null. '
      + 'Read a screenshot you saved with read to see the screen. Other commands: run_on_host.',
    allowText: 'chạy đúng lệnh simulator/build app này một lần trên máy bạn, ngoài sandbox: build có thể chạy script build của project bằng quyền của bạn.',
    confirm: (owner, command) => credentialReason(command) ?? (runsProjectCode(command, owner.cwd) ? alwaysAsk(owner, 'the command runs a script of the project on this machine, outside the sandbox') : owner.permission.confirmation(command)) },
};
// The reason every mode asks about a command, as the card shows it; Ask first needs none.
const alwaysAsk = (owner, reason) => (owner.permission.mode === 'ask' ? 'ask' : reason);
const DENIED_TEXT = 'Từ chối: lệnh không chạy, agent được báo bạn đã từ chối.';
const textResult = text => ({ content: [{ type: 'text', text }], details: undefined });

// Why a mode that runs commands without asking asks about this one, as the card says it.
export function stillAsks(mode, reason) {
  return mode === 'bypass' ? { en: `Bypass still asks: ${reason}`, vi: `Bypass vẫn hỏi: ${reason}` } : { en: `Full access still asks: ${reason}`, vi: `Full access vẫn hỏi: ${reason}` };
}

// owner: { boundary, cwd, permission, approvals, checkpoints?, hooks? }. deps: injectable host side effects (tests).
export function commandTools(owner, deps = {}) {
  const { runHost = runHostCommand, alive = engineAlive, launcher: findLauncher = engineLauncher, spawnImpl = spawn, wait = 180_000, every = 2000 } = deps;
  const engineReady = async () => {
    if (owner.boundary.engine && await alive(owner.boundary.engine.socket)) return true;
    return owner.boundary.refreshEnvironment() && alive(owner.boundary.engine.socket);
  };
  const dockerStopped = 'managed-docker-unreachable: Docker engine trên máy không chạy. Gọi start_docker để xin member duyệt mở Docker, rồi chạy lại đúng lệnh này bằng run_with_docker.';

  const commandTool = kind => {
    const spec = KINDS[kind];
    return { name: spec.name, label: spec.label, description: spec.description, parameters: PARAMETERS,
      execute: async (_id, args, signal, onUpdate, ctx) => {
        if (kind === 'docker' && !await engineReady()) throw Error(dockerStopped);
        const memberOnly = kind === 'host' ? memberOnlyReason(args.command) : null;
        if (memberOnly) throw Error(MEMBER_ONLY(memberOnly));
        const notSimulator = kind === 'simulator' ? simulatorCommandReason(args.command, owner.cwd) : null;
        if (notSimulator) throw Error(`managed-simulator-command: ${notSimulator}.`);
        const confirm = await spec.confirm(owner, args.command);
        if (confirm !== null) {
          const why = confirm === 'ask' ? null : stillAsks(owner.permission.mode, confirm);
          await owner.approvals.request(ctx, { key: `${spec.name} ${args.command}`, title: spec.title,
            body: `${args.command}\n\nLý do: ${args.reason}${why ? `\n${why.vi}` : ''}\n\nĐồng ý: ${spec.allowText}\n${DENIED_TEXT}` }, signal);
        }
        await owner.checkpoints?.take(owner.turn?.());
        try {
          if (kind === 'simulator' && detachedEmulator(args.command)) {
            const command = `nohup ${args.command} >/dev/null 2>&1 & sleep 3; echo "Emulator started in the background; wait for it with: adb wait-for-device"`;
            return await runHost({ command, cwd: owner.cwd, userHome: owner.boundary.userHome, timeout: 60, signal, onUpdate });
          }
          if (kind === 'host' || kind === 'simulator') return await runHost({ command: args.command, cwd: owner.cwd, userHome: owner.boundary.userHome, timeout: args.timeout, signal, onUpdate });
          return await owner.boundary.invoke('bash', { command: args.command, ...(args.timeout ? { timeout: args.timeout } : {}) }, signal, onUpdate, ctx?.model,
            kind === 'docker' ? { docker: true } : { network: true });
        } finally {
          if (kind === 'host') owner.boundary.refreshEnvironment(); // what the command installed is there for the next one
        }
      } };
  };

  // start_docker: the engine the member installed, started after they approve (Full access and Bypass start it without asking), then waited for.
  const startDocker = { name: 'start_docker', label: 'Start Docker',
    description: 'Start the Docker engine installed on this machine (Docker Desktop, OrbStack, Colima, rootless Docker) after the member approves, and wait until it answers; '
      + 'run_with_docker works right after. Use it when a command reports that Docker is not running.',
    parameters: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } } },
    execute: async (_id, args, signal, _onUpdate, ctx) => {
      if (await engineReady()) return textResult('The Docker engine is running: use run_with_docker.');
      const launcher = findLauncher({ userHome: owner.boundary.userHome });
      if (!launcher) {
        throw Error(owner.boundary.dockerCli ? MEMBER_ONLY("starting this machine's Docker service needs the member's password")
          : 'managed-docker-not-installed: Máy chưa cài Docker. Hỏi member: cài Docker Desktop hoặc OrbStack, hay chạy check theo cách khác.');
      }
      const preview = `${launcher.command} ${launcher.args.join(' ')}`;
      if (!owner.permission.broadAccess) {
        await owner.approvals.request(ctx, { key: `start_docker ${preview}`, title: `Mở ${launcher.label}`,
          body: `${preview}\n\nLý do: ${args.reason}\n\nĐồng ý: mở ${launcher.label} trên máy; nó vẫn chạy sau cuộc trò chuyện.\nTừ chối: không mở Docker, agent được báo bạn đã từ chối.` }, signal);
      }
      const env = { HOME: owner.boundary.userHome, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', USER: process.env.USER ?? '', LANG: 'en_US.UTF-8' };
      try { spawnImpl(launcher.command, launcher.args, { detached: true, stdio: 'ignore', env }).on('error', () => {}).unref(); } catch { /* waited for below */ }
      for (const until = Date.now() + wait; Date.now() < until;) {
        if (signal?.aborted) throw Error('managed-tool-cancelled');
        await new Promise(resolve => setTimeout(resolve, every));
        if (await engineReady()) return textResult(`${launcher.label} is running. Run the Docker command again with run_with_docker.`);
      }
      throw Error(`managed-docker-start-timeout: ${launcher.label} đã được mở nhưng engine chưa trả lời sau ${Math.round(wait / 60000)} phút `
        + '(lần đầu mở app có thể chờ member bấm đồng ý điều khoản). Hỏi member, kèm lựa chọn "Docker đã chạy, thử lại" và "Bỏ qua bước này".');
    } };

  const docker = owner.boundary.engine || owner.boundary.dockerCli;
  return [commandTool('network'), ...(docker ? [commandTool('docker')] : []), startDocker, commandTool('host'), commandTool('simulator')];
}
