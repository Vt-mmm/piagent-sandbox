import path from 'node:path';

// The macOS profile. Default-deny protects Keychain, the SSH agent, Agent Watch IPC and process inspection.
// System libraries and toolchains are read-only; writes stay in the project and a fresh temporary directory.
// There is no network exception and no unsandboxed fallback.
const SYSTEM = ['/Library/Frameworks', '/Library/Java', '/Library/Apple', '/private/var/db/oah', '/private/var/db/timezone'];
// Names of files that hold credentials wherever they are (the project, a folder the member pointed to). Keep in step with credentialName
// in linux-sandbox.mjs.
const CREDENTIAL_NAMES = String.raw`(^|/)(\.env([-./_]|$)|credentials([./]|$)|\.(npmrc|netrc|pypirc|git-credentials|dev\.vars)$|secrets?\.(json|ya?ml|toml)$|id_(rsa|dsa|ecdsa|ed25519)(\.[^/]*)?$|serviceAccount[^/]*\.json$|[^/]+\.(pem|key|p12|pfx)$)`;
// Committed templates and the public certificate bundles that pip and other tools ship (certifi's cacert.pem).
const TEMPLATES = String.raw`(^|/)\.env[-._](example|sample|template|dist|defaults)$|cacert\.pem$`;
// Files that make git run a program (config, hooks, attributes, submodule list): the agent may not write them, so git on the host
// and the member's later commit or push never run what it planted. Matches any .git folder, a worktree's too.
const GIT_EXEC_FILES = String.raw`(^|/)(\.git/([^/]+/)*(config|config\.worktree|hooks(/.*)?|info/attributes|modules/.+/config)|\.gitmodules|\.gitattributes)$`;

export function literal(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('managed-path-invalid');
  return JSON.stringify(value);
}
export const inside = (file, root) => file === root || file.startsWith(root + path.sep);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Folders a member points the agent to for reference (an @ mention): their own files, external drives and the
// shared folder, read-only. Hidden entries of the home folder and ~/Library stay closed, except read roots there.
// Seatbelt lets a rule naming file-read-data win over one naming file-read*, so the roots are left out of the
// deny rule rather than allowed again after it.
function referenceRules(home, roots) {
  if (!home || /["\\]/.test(home)) return '';
  const opened = roots.filter(root => inside(root, home)).map(root => ` (require-not (subpath ${literal(root)}))`).join('');
  return `(allow file-read* (subpath ${literal(home)}) (subpath "/Volumes") (subpath "/Users/Shared") (subpath "/private/tmp"))
(deny file-read-data file-read-xattr (require-all (require-any (regex #"^${escapeRegex(home)}/\\.") (subpath ${literal(path.join(home, 'Library'))}))${opened}))`;
}

export function managedSeatbelt({ cwd, sdkRoot, runtimeRoot, temporary, node, denied = [], readOnly = false, repository = [], gitDirs = [], toolchains = [],
  developer = [], browsers = [], network = false, references = null, skills = [], caches = [], loopback = true, license = null, docker = null, proxyPort = null }) {
  const readRoots = ['/System', '/usr', '/bin', '/sbin', '/Library/Developer', '/Applications/Xcode.app', '/opt/homebrew', ...SYSTEM, ...developer,
    sdkRoot, runtimeRoot, cwd, temporary, ...repository, ...gitDirs, ...toolchains, ...skills, ...caches, ...browsers].filter(Boolean);
  const subpaths = list => list.map(root => `(subpath ${literal(root)})`).join(' ');
  const writeRoots = [temporary, ...caches, ...(!readOnly ? [cwd, ...gitDirs] : [])];
  // Credential files are unreadable, unwritable and hidden: a stat fails, so a tool that loads them when present
  // (Vite reads .env.local) carries on without them. auth.json holds credentials at a project's root or in a dot folder.
  const projectAuth = [...new Set([cwd, ...repository])].map(root => `(literal ${literal(path.join(root, 'auth.json'))})`).join(' ');
  // com.apple.SecurityServer (the keychain service) is reachable only for a command that was approved to use the network.
  const trust = `(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.ocspd")${network ? ' (global-name "com.apple.SecurityServer")' : ''})
(allow file-read* (subpath "/private/var/db/mds") (literal "/Library/Keychains/System.keychain") (subpath "/Library/Security/Trust Settings"))`;
  // Every command may start servers and reach them (a test's own server, Playwright's Chromium). The rule names loopback;
  // a server it starts is reachable while it runs. Without approval nothing else is reached: no internet, no name lookups.
  // While a local proxy listens, not even loopback (Seatbelt cannot close one port of an open loopback).
  let networkRules;
  if (network) {
    networkRules = `(allow network-outbound (remote ip))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow system-socket)
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.SystemConfiguration.configd"))
${trust}${docker ? `\n(allow network-outbound (literal ${literal(docker)}))` : ''}`;
  } else if (loopback) networkRules = '(allow network-outbound (remote ip "localhost:*"))';
  else networkRules = proxyPort ? `(allow network-outbound (remote ip "localhost:${Number(proxyPort)}"))` : '';
  const denies = denied.map(root => {
    const except = skills.filter(dir => inside(dir, root) && dir !== root).map(dir => ` (require-not (subpath ${literal(dir)}))`).join('');
    return `(deny file-read* file-write* (require-all (subpath ${literal(root)})${except}))`;
  }).join('\n');
  return `(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd"))
(allow file-read-metadata)
(allow file-read* (literal "/") ${subpaths(readRoots)} (literal ${literal(node)}) (subpath "/private/etc") (subpath "/dev")${license ? ` (literal ${literal(license)})` : ''})
${referenceRules(references, readRoots)}
(allow file-write* ${subpaths(writeRoots)} (literal "/dev/null") (literal "/dev/tty"))
(allow network-bind network-inbound (local ip "localhost:*"))
(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))
(allow mach-register mach-lookup (global-name-regex #"^org\\.chromium\\."))
${proxyPort && !network ? trust : ''}
${networkRules}
${denies}
${gitDirs.map(dir => `(deny file-write* (literal ${literal(path.join(dir, 'config'))}) (literal ${literal(path.join(dir, 'config.worktree'))}) (subpath ${literal(path.join(dir, 'hooks'))}) (literal ${literal(path.join(dir, 'info/attributes'))}))`).join('\n')}
(deny file-write* (regex #"${GIT_EXEC_FILES}") ${[...new Set([cwd, ...repository])].map(root => `(literal ${literal(path.join(root, '.git'))})`).join(' ')})
(deny file-read* file-read-metadata file-write* (require-all (require-any (regex #"${CREDENTIAL_NAMES}") (regex #"/\\.[^/]+/auth\\.json$") ${projectAuth})
  (require-not (regex #"${TEMPLATES}"))))
`;
}

// A company terminal's shell under this profile also needs ioctls on its own terminal device and /dev/tty.
export const SEATBELT_TERMINAL_RULES = `
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))
(allow file-read* file-write* file-ioctl (literal "/dev/tty"))
`;
