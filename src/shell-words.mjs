// A small shell reader for policy checks. It splits a command line into the simple commands it runs
// (`;`, `&`, `&&`, `||`, `|`, newlines, groups, `$( )`, backticks, `bash -c '…'`), each as a list of
// words with the quotes resolved. It follows no variables or aliases: the policies that use it are
// advisory text checks on top of the sandbox, not the boundary.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'env']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time']);
const isAssignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);

// Words of one simple command without leading assignments and wrappers (`env X=1 nohup git push`).
export function stripWrapper(words) {
  let rest = [...words];
  for (;;) {
    while (rest.length && isAssignment(rest[0])) rest = rest.slice(1);
    const name = rest[0]?.split('/').pop();
    if (!WRAPPERS.has(name)) return rest;
    rest = rest.slice(1);
    if (name === 'env') while (rest[0]?.startsWith('-') || isAssignment(rest[0] ?? '')) rest = rest.slice(1);
    else while (rest[0]?.startsWith('-')) rest = rest.slice(1);
  }
}

// Text inside the first balanced `$( … )` starting at `from` (the index after "$("), and where it ends.
function balanced(text, from) {
  let depth = 1;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && !--depth) return { inner: text.slice(from, i), end: i + 1 };
  }
  return { inner: text.slice(from), end: text.length };
}

export function commandSegments(command, depth = 0) {
  const text = String(command ?? ''), segments = [], nested = [];
  let words = [], word = null, quote = null;
  const push = () => { if (word !== null) { words.push(word); word = null; } };
  const flush = () => {
    push();
    while (words.length && KEYWORDS.has(words[0])) words = words.slice(1);
    if (words.length) segments.push({ words });
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (c === '\\' && i + 1 < text.length) { word = (word ?? '') + text[++i]; continue; }
    if (quote === '"' && c === '"') { quote = null; continue; }
    if (c === '$' && text[i + 1] === '(' || c === '`') {
      const sub = c === '`' ? { inner: text.slice(i + 1, text.indexOf('`', i + 1) < 0 ? text.length : text.indexOf('`', i + 1)) } : balanced(text, i + 2);
      nested.push(sub.inner);
      i = c === '`' ? i + sub.inner.length + 1 : sub.end - 1;
      word = (word ?? '') + '$SUB'; // the value is known only at run time
      continue;
    }
    if (quote === '"') { word += c; continue; }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (/\s/.test(c) && c !== '\n') { push(); continue; }
    if (';&|\n(){}'.includes(c)) { flush(); continue; }
    word = (word ?? '') + c;
  }
  flush();
  // `bash -c '…'` and substitutions are commands too.
  for (const { words: w } of [...segments]) {
    const run = stripWrapper(w);
    const at = run.findIndex(item => /^-[a-z]*c$/.test(item));
    if (SHELLS.has(run[0]?.split('/').pop()) && at > 0 && run[at + 1]) nested.push(run[at + 1]);
  }
  if (depth < 4) for (const inner of nested) segments.push(...commandSegments(inner, depth + 1));
  return segments;
}
