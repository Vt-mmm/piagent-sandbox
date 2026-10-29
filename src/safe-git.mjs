import { execFileSync } from 'node:child_process';

// git run on the host over a folder the sandbox could write. The repository's own configuration, attributes and hooks are data
// from the agent: they must not start a program (core.fsmonitor, textconv, external diff, hooks, pagers, protocol helpers).
// The sandbox profile also refuses writes to those files; this is the second wall for what was there before.
export const SAFE_GIT_ARGS = Object.freeze(['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false',
  '-c', 'core.sshCommand=false', '-c', 'core.askPass=', '-c', 'credential.helper=', '-c', 'protocol.ext.allow=never', '-c', 'diff.external=', '-c', 'gc.auto=0']);
export const NO_EXEC_DIFF = Object.freeze(['--no-ext-diff', '--no-textconv']);

export function safeGitEnv(base = process.env) {
  const env = { ...base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1', GIT_PAGER: 'cat' };
  for (const name of ['GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[name];
  return env;
}

// `diff`/`show`/`log` style commands also get the no-textconv switches after the subcommand.
export function safeGitArgs(args) {
  const [sub, ...rest] = args;
  return [...SAFE_GIT_ARGS, sub, ...(['diff', 'show', 'log'].includes(sub) ? NO_EXEC_DIFF : []), ...rest];
}

export function runSafeGit(bin, cwd, args, options = {}) {
  return execFileSync(bin, ['-C', cwd, ...safeGitArgs(args)], { ...options, env: safeGitEnv(options.env) });
}
