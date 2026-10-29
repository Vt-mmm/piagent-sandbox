import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { SAFE_GIT_ARGS, safeGitEnv } from './safe-git.mjs';

// fetch_origin: one approved `git fetch` of the GitHub origin. The credential never enters the sandbox: the runtime downloads the
// branches into a staging bare repository, then the sandbox imports them from that local copy. Working files and the current branch
// do not change. Full access and Bypass fetch without asking (it only downloads).
const GITHUB = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const run = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 << 20, ...options }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});
export const FETCH_FAILED = 'managed-repository-fetch-failed: fetch_origin không tải được nhánh từ GitHub (repo cần quyền mà tài khoản trên máy không có, chưa đăng nhập, '
  + 'mạng lỗi hoặc tải quá lâu). Dùng run_on_host để member duyệt chạy git fetch trên máy bằng tài khoản của họ.';

export async function fetchPlan(cwd, sub = '', { git = 'git' } = {}) {
  const target = path.resolve(cwd, sub || '.');
  const inside = (file, root) => { const rel = path.relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
  if (!inside(target, cwd)) throw new Error('managed-path-invalid');
  try { if (!inside(fs.realpathSync(target), fs.realpathSync(cwd))) throw new Error('managed-path-invalid'); } catch (error) { if (error.message === 'managed-path-invalid') throw error; }
  const url = (await run(git, ['-C', target, ...SAFE_GIT_ARGS, 'remote', 'get-url', 'origin'], { env: safeGitEnv({ PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: os.tmpdir() }) })).trim();
  const repository = GITHUB.exec(url)?.[1];
  if (!repository) throw new Error('managed-repository-unsupported: origin phải là một repository trên github.com');
  return { cwd: target, url: `https://github.com/${repository}.git`, repository };
}

// Default transport: git over HTTPS into `staging`, with a token from `token()` when the member's `gh` is signed in.
export async function fetchRepositoryBundle(plan, staging, { git = 'git', token = async () => '', signal } = {}) {
  fs.mkdirSync(staging, { recursive: true });
  await run(git, ['init', '--bare', '--quiet', staging]);
  const secret = await token();
  const auth = secret ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}` } : {};
  await run(git, ['-C', staging, '-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=100', plan.url, '+refs/heads/*:refs/heads/*'],
  { env: { PATH: '/usr/bin:/bin:/opt/homebrew/bin', HOME: os.tmpdir(), GIT_TERMINAL_PROMPT: '0', ...auth }, signal });
}

export function fetchOriginTool(owner, { transport = fetchRepositoryBundle, git = 'git' } = {}) {
  const execute = async (plan, signal) => {
    const staging = path.join(owner.boundary.temporary, `approved-origin-${Date.now()}`);
    try {
      await transport(plan, staging, { git, signal });
      const q = value => `'${String(value).replaceAll("'", "'\\''")}'`;
      // The import runs in the sandbox: a repository's hooks and config cannot reach credentials.
      const command = [`git -C ${q(plan.cwd)}`, '-c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.file.allow=always',
        `fetch --no-tags --no-recurse-submodules --no-write-fetch-head --update-shallow ${q(staging)} '+refs/heads/*:refs/remotes/origin/*'`].join(' ');
      await owner.boundary.invoke('bash', { command }, signal);
      return { content: [{ type: 'text', text: `Fetched origin branches for ${plan.repository}. Working files and current branch were not changed.` }], details: undefined };
    } catch (error) {
      if (/managed-operation|aborted/.test(String(error?.message))) throw error;
      throw new Error(`${FETCH_FAILED}\n${String(error?.message ?? error).slice(0, 400)}`);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  };
  return { name: 'fetch_origin', label: 'Fetch origin',
    description: 'Request one approved GitHub origin fetch. Refreshes origin branches without changing working files. Does not expose credentials or allow arbitrary network commands. '
      + 'When the conversation folder holds several repositories, pass path: the repository folder inside it. Use this instead of git fetch, which has no GitHub sign-in here.',
    parameters: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', maxLength: 500 } } },
    execute: async (_id, args, signal, _onUpdate, ctx) => {
      const plan = await fetchPlan(owner.cwd, args?.path, { git });
      if (!owner.permission.broadAccess) {
        await owner.approvals.request(ctx, { key: `fetch_origin ${plan.url}`, title: 'Tải nhánh từ origin',
          body: `Tải các nhánh của ${plan.repository} về ${plan.cwd} một lần.\n\nĐồng ý: chỉ tải nhánh; nhánh hiện tại và file đang làm không đổi.\n`
            + 'Từ chối: không gọi mạng, không đọc thông tin đăng nhập.' }, signal);
      }
      return execute(plan, signal);
    } };
}
