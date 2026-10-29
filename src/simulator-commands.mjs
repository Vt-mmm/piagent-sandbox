import path from 'node:path';

// What run_on_simulator runs on the member's machine: the iOS Simulator, the Android emulator and the
// builds that install an app on them (the sandbox reaches neither CoreSimulator nor adb). Only these
// programs, joined by &&, || or a pipe into an output filter; output may go to a file in the project.
// Anything wider is run_on_host.
const XCRUN = new Set(['simctl', 'xcodebuild', 'devicectl', 'xcresulttool', 'xctrace']);
// `simctl spawn` starts a program of the simulator's runtime: only `log`.
const simctl = words => words[1] !== 'simctl' || words[2] !== 'spawn' || words.slice(3).filter(word => !word.startsWith('-'))[1] === 'log';
const NPX = /^(expo|react-native|@react-native-community\/cli|cap|@capacitor\/cli)(@[\w.-]+)?$/;
const any = () => true;
const PROGRAMS = {
  xcrun: words => XCRUN.has(words[1]) && simctl(words),
  xcodebuild: any, adb: any, emulator: any, avdmanager: any, sdkmanager: any, flutter: any,
  open: words => words.length === 3 && words[1] === '-a' && words[2] === 'Simulator',
  gradlew: (words, inProject) => inProject(words[0]),
  axe: words => !!words[1] && words[1] !== 'init',
  xcodegen: words => words[1] === 'generate',
  pod: words => words[1] === 'install',
  npx: words => NPX.test(words[1] === '--yes' || words[1] === '-y' ? words[2] ?? '' : words[1] ?? ''),
  sleep: words => words.length === 2 && /^\d{1,3}$/.test(words[1]),
  xcbeautify: any, xcpretty: any, grep: any, head: any, tail: any, wc: any, sort: any, uniq: any, jq: any,
  cd: (words, inProject) => words.length === 2 && inProject(words[1]),
  mkdir: (words, inProject) => { const paths = words.slice(1).filter(word => word !== '-p'); return paths.length > 0 && paths.every(inProject); },
};
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=/;
const UNSAFE_VARIABLE = /^(PATH|DYLD_\w*|LD_\w*|NODE_OPTIONS|BASH_ENV|ENV|ZDOTDIR|SHELL|HOME)$/;

// A path in the project: relative without climbing out, or absolute inside it. Without `cwd`, only relative.
function insideProject(cwd) {
  return target => {
    if (typeof target !== 'string' || !target || target.startsWith('~') || target.includes('$') || target.split('/').includes('..')) return false;
    if (!target.startsWith('/')) return true;
    if (!cwd) return false;
    const relative = path.relative(path.resolve(cwd), path.resolve(target));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
}

// Shell words with quotes resolved, and the operators between them; null for an unclosed quote.
function tokens(command) {
  const out = []; let word = null, quote = null;
  const push = () => { if (word !== null) { out.push({ word }); word = null; } };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (c === '\\' && i + 1 < command.length) { word = (word ?? '') + command[++i]; continue; }
    if (/\s/.test(c)) { push(); continue; }
    const two = command.slice(i, i + 2);
    if (['&&', '||', '>>', '2>'].includes(two)) {
      push();
      if (two === '2>' && command.slice(i + 2, i + 4) === '&1') { out.push({ op: '2>&1' }); i += 3; continue; }
      out.push({ op: two }); i += 1; continue;
    }
    if (c === '|' || c === '>') { push(); out.push({ op: c }); continue; }
    word = (word ?? '') + c;
  }
  if (quote) return null;
  push();
  return out;
}

// Why the command is not a simulator command, or null when it is. `cwd`: the project, where output files and `cd` may go.
export function simulatorCommandReason(command, cwd = null) {
  const text = String(command ?? ''), inProject = insideProject(cwd);
  if (!text.trim()) return 'the command is empty';
  if (/[`;\n]|\$\(|<\(|>\(|</.test(text) || text.replaceAll('&&', '').replaceAll('2>&1', '').includes('&'))
    return 'only commands joined by &&, || or | are run (no ;, &, $( ), backticks or subshells)';
  const list = tokens(text);
  if (!list) return 'an unclosed quote';
  let words = [];
  const close = () => {
    if (!words.length) return 'an empty part between operators';
    while (words.length && ASSIGNMENT.test(words[0])) {
      const name = ASSIGNMENT.exec(words[0])[1];
      if (UNSAFE_VARIABLE.test(name)) return `${name} cannot be set here`;
      words = words.slice(1);
    }
    const name = words[0]?.split('/').pop();
    const allowed = Object.hasOwn(PROGRAMS, name) && PROGRAMS[name](words, inProject);
    words = [];
    return allowed ? null : `${name ?? 'this part'} is not a simulator or app build command (use run_on_host for other commands)`;
  };
  for (let i = 0; i < list.length; i += 1) {
    const { word, op } = list[i];
    if (word !== undefined) { words.push(word); continue; }
    if (op === '2>&1') continue;
    if (op === '>' || op === '>>' || op === '2>') {
      const target = list[i + 1]?.word;
      if (!(target === '/dev/null' || inProject(target))) return 'output may go only to a file inside the project or /dev/null';
      i += 1; continue;
    }
    const reason = close();
    if (reason) return reason;
  }
  return close();
}

// A lone `emulator …` keeps running while the virtual device is up: it starts detached.
export function detachedEmulator(command) {
  const list = tokens(String(command ?? ''));
  return !!list && list.length > 0 && list.every(token => token.word !== undefined) && list[0].word.split('/').pop() === 'emulator';
}
