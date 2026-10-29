import { commandSegments, stripWrapper } from './shell-words.mjs';

export { stripWrapper, commandSegments };

// What every permission mode asks about, Bypass included ("Bypass bypasses the work and stops at the handoff").
// handoffReason: the work leaves this machine: push, pull request or merge, release, package publish, deploy,
// registry push or login, remote shell, cloud or cluster tool, upload.
// mustConfirm: the handoff plus what is destructive or irreversible here. Full access asks; Bypass runs these.
const REMOTE = new Set(['ssh', 'scp', 'sftp', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'firebase', 'aws', 'gcloud', 'gsutil', 'az',
  'kubectl', 'helm', 'terraform', 'tofu', 'pulumi', 'eas', 'wrangler', 'supabase', 'railway', 'render', 'doctl']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const LAUNCHERS = new Map([['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])], ['xargs', new Set(['-I', '-n', '-P', '-L', '-d', '-s', '-E', '-a'])],
  ['watch', new Set(['-n', '--interval', '-d'])], ['caffeinate', new Set(['-t', '-w'])]]);
const PUBLISHERS = [['cargo', 'publish'], ['twine', 'upload'], ['gem', 'push'], ['pod', 'trunk', 'push'], ['dotnet', 'nuget', 'push'], ['mvn', 'deploy'],
  ['gradle', 'publish'], ['gradlew', 'publish'], ['poetry', 'publish'], ['uv', 'publish'], ['flutter', 'pub', 'publish'], ['dart', 'pub', 'publish'],
  ['vsce', 'publish'], ['ovsx', 'publish']];
const DEPLOY_SCRIPT = /^(deploy|publish|release|push)([:_-]|$)/;
const GH_REMOTE = [['pr', 'create'], ['pr', 'merge'], ['pr', 'comment'], ['pr', 'review'], ['pr', 'close'], ['release', 'create'], ['release', 'upload'],
  ['issue', 'create'], ['issue', 'comment'], ['repo', 'create'], ['repo', 'delete'], ['workflow', 'run'], ['gist', 'create']];
const UPLOAD_FLAGS = /^(-T|--upload-file|-d|--data(-\w+)?|-F|--form|--post-data|--post-file|--body-data|--body-file)$/;

function executable(words) {
  let current = stripWrapper(words);
  for (;;) {
    if (['sudo', 'doas'].includes(current[0])) {
      current = stripWrapper(current.slice(1));
      while (current[0]?.startsWith('-')) current = current.slice(1);
      continue;
    }
    if (RUNNERS.has(current[0]) || (['pnpm', 'yarn'].includes(current[0]) && current[1] === 'dlx')) {
      current = current.slice(['pnpm', 'yarn'].includes(current[0]) ? 2 : 1);
      while (current[0]?.startsWith('-')) current = current.slice(1);
    } else if (LAUNCHERS.has(current[0])) {
      const valued = LAUNCHERS.get(current[0]), duration = current[0] === 'timeout';
      current = current.slice(1);
      while (current[0]?.startsWith('-')) current = current.slice(valued.has(current[0]) ? 2 : 1);
      if (duration) current = current.slice(1);
    } else break;
    current = stripWrapper(current);
  }
  // `git -C dir push` and `git -c k=v push` are a push.
  if (current[0] === 'git') {
    const rest = [];
    for (let i = 1; i < current.length; i += 1) {
      if (['-C', '-c', '--git-dir', '--work-tree'].includes(current[i])) { i += 1; continue; }
      if (current[i].startsWith('--git-dir=') || current[i].startsWith('--work-tree=') || /^-c./.test(current[i])) continue;
      rest.push(...current.slice(i)); break;
    }
    return ['git', ...rest];
  }
  return current;
}
const positional = args => args.filter(arg => !arg.startsWith('-'));

function segmentHandoff(words) {
  const [name, ...args] = executable(words);
  const sub = positional(args);
  if (!name) return null;
  const base = name.split('/').pop();
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base) && ['run', 'run-script'].includes(sub[0]) && DEPLOY_SCRIPT.test(sub[1] ?? '')) return `${base} run ${sub[1]} deploys or publishes`;
  if (base === 'make' && sub.some(target => DEPLOY_SCRIPT.test(target))) return 'make runs a release or deploy target';
  if (REMOTE.has(base)) return `${base} reaches another machine or account`;
  if (base === 'git') {
    if (words.some((word, i) => (word === '-c' && /^alias\./i.test(words[i + 1] ?? '')) || /^-calias\./i.test(word))) return 'git runs an alias defined in the command';
    if (['push', 'send-email', 'request-pull'].includes(sub[0])) return `git ${sub[0]} sends to a remote`;
    if (['subtree', 'lfs'].includes(sub[0]) && sub[1] === 'push') return `git ${sub[0]} push sends to a remote`;
    return null;
  }
  if (base === 'gh') {
    const hit = GH_REMOTE.find(entry => entry.every((word, i) => sub[i] === word));
    if (hit) return `gh ${hit.join(' ')} changes something on GitHub`;
    const verb = args[args.findIndex(arg => /^(-X|--method)$/.test(arg)) + 1];
    if (sub[0] === 'api' && verb && !/^get$/i.test(verb)) return 'gh api writes to GitHub';
    return null;
  }
  if (base === 'rsync' && args.some(arg => /^[^/\s]*:/.test(arg) && !arg.startsWith('-'))) return 'rsync to another machine';
  if (['curl', 'wget'].includes(base)) {
    const writes = args.some((arg, i) => UPLOAD_FLAGS.test(arg) || (/^(-X|--request)$/.test(arg) && /^(POST|PUT|PATCH|DELETE)$/i.test(args[i + 1] ?? '')));
    return writes ? `${base} uploads data to a site` : null;
  }
  if (['docker', 'podman'].includes(base)) {
    if (['push', 'login'].includes(sub[0])) return `${base} ${sub[0]} sends to a registry`;
    if (args.includes('--push')) return `${base} build --push sends to a registry`;
    return null;
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(base) && (sub[0] === 'publish' || (sub[0] === 'npm' && sub[1] === 'publish'))) return `${base} publish uploads a package`;
  const publisher = PUBLISHERS.find(entry => entry[0] === base.replace(/^\.\//, '') && entry.slice(1).every((word, i) => sub[i] === word));
  return publisher ? `${publisher.join(' ')} uploads a package` : null;
}

// Why this command hands the work off (asked in every mode), or null.
export function handoffReason(command) {
  for (const segment of commandSegments(command)) {
    const reason = segmentHandoff(segment.words);
    if (reason) return reason;
  }
  return null;
}

const gitDiscards = a => (a[0] === 'reset' && a.includes('--hard')) || (a[0] === 'clean' && a.some(x => /^-\w*f/.test(x)))
  || (a[0] === 'checkout' && a.includes('--'));
const recursiveRm = a => a.some(x => /^-\w*r/.test(x) || x === '--recursive')
  && positional(a).some(x => /^(\/|~|\$|\*)/.test(x) || x.includes('$') || x === '.');
const DESTRUCTIVE = [
  [/^git$/, a => gitDiscards(a) ? 'git discards local work' : null],
  [/^rm$/, a => recursiveRm(a) ? 'rm -r on a path known only at run time' : null],
  [/^(docker|podman)$/, a => (a[0] === 'volume' && a[1] === 'rm') || (a[0] === 'system' && a[1] === 'prune')
    || (a.includes('down') && a.includes('-v')) ? 'removes Docker volumes' : null],
  [/^(prisma|rails|rake|flyway|liquibase|alembic|sequelize|knex)$/, a => a.some(x => /migrat|db:push|drop|upgrade|reset/.test(x)) ? 'a database migration' : null],
  [/^(psql|mysql|sqlite3|mongosh)$/, a => /\bdrop\s+(table|database)\b|\btruncate\b/i.test(a.join(' ')) ? 'drops database data' : null],
];

// Why Full access must still ask about this command, or null.
export function mustConfirm(command) {
  const handoff = handoffReason(command);
  if (handoff) return handoff;
  for (const { words } of commandSegments(command)) {
    const run = stripWrapper(words);
    if (['sudo', 'doas'].includes(run[0])) return 'sudo runs as another user';
    const name = executable(words)[0]?.split('/').pop();
    const args = executable(words).slice(1);
    for (const [rule, check] of DESTRUCTIVE) if (rule.test(name ?? '')) { const reason = check(args); if (reason) return reason; }
  }
  return null;
}

// Whether an MCP tool writes to the system behind its server, read from the verb in the tool's name.
const WRITE_VERBS = /(^|[_.\-:])(create|update|delete|remove|write|send|post|push|merge|publish|deploy|upload|set|add|edit|close|assign|transition|comment|move|archive)([_.\-:]|$)/i;
export const mcpWriteAction = tool => WRITE_VERBS.exec(String(tool))?.[2]?.toLowerCase() ?? null;
