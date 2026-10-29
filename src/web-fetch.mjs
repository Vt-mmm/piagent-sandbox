
import https from 'node:https';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { privateAddress } from './ip-policy.mjs';

// web_fetch of the company sandbox: a GET of a public https page, read as text. The runtime (not the sandbox) makes the request, so it
// holds the rules itself: the name is resolved here, an address that is private, local or not routable is refused, the connection goes to
// the address that was checked (a second lookup cannot answer differently), every redirect is checked again from the start and may
// not leave the host it started on, no cookie, header or credential of the member is sent, and the page is cut at a size.
export const MAX_BYTES = 2 * 1024 * 1024, MAX_REDIRECTS = 4, TIMEOUT_MS = 15_000;
const TEXT = /^(text\/|application\/(json|xml|xhtml\+xml|javascript|x-yaml|yaml)|image\/svg\+xml)/i;

// Default transport: one GET to `ip` with the TLS name of `host`. -> { status, headers, body (Buffer, at most max bytes) }
export function httpsGet(url, ip, { max = MAX_BYTES, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host: url.hostname, servername: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: 'GET',
      headers: { 'User-Agent': 'piagent-web-fetch', Accept: 'text/*, application/json, application/xml;q=0.9', 'Accept-Encoding': 'identity' },
      lookup: (_name, _options, callback) => callback(null, [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }]), timeout, agent: false }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > max) { response.destroy(); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).subarray(0, max), truncated: true }); } else chunks.push(chunk); });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('managed-web-fetch-timeout')));
    request.on('error', reject);
    request.end();
  });
}

const refuse = reason => new Error(`managed-web-fetch-refused: ${reason}`);

// -> { url, status, contentType, text, truncated }. `resolve` and `transport` are injectable (tests).
export async function safeFetch(raw, { resolve = name => lookup(name, { all: true }), transport = httpsGet, isPrivate = privateAddress } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw refuse('not an address'); }
  const origin = url.hostname.toLowerCase();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (url.protocol !== 'https:') throw refuse('only https addresses are read');
    if (url.username || url.password) throw refuse('an address with a login is not read');
    if (url.port && url.port !== '443') throw refuse('only port 443');
    const host = url.hostname.toLowerCase();
    if (host !== origin) throw refuse(`redirected to another host (${host}); fetch that address directly so the member can approve it`);
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) throw refuse('an address given as an IP number is not read');
    const addresses = await resolve(host);
    if (!addresses.length || addresses.some(entry => isPrivate(entry.address))) throw refuse('the name resolves to a private or local address');
    const answer = await transport(url, addresses[0].address);
    if ([301, 302, 303, 307, 308].includes(answer.status)) {
      const location = answer.headers?.location;
      if (!location) throw refuse('a redirect without a location');
      url = new URL(location, url);
      continue;
    }
    const type = String(answer.headers?.['content-type'] ?? '');
    if (!TEXT.test(type)) throw refuse(`content type ${type || 'unknown'} is not text`);
    return { url: url.href, status: answer.status, contentType: type, text: answer.body.toString('utf8'), truncated: Boolean(answer.truncated) };
  }
  throw refuse('too many redirects');
}

export function webFetchTool({ fetchImpl = safeFetch } = {}) {
  return { name: 'web_fetch', label: 'Web fetch',
    description: 'Read one public https page as text (GET, no cookies, no login, at most 2 MB). Documentation sites are read freely; another host is asked about first. '
      + 'Private and local addresses are never read, and a redirect to another host is not followed: fetch the new address instead.',
    parameters: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', maxLength: 2000 } } },
    execute: async (_id, args) => {
      const page = await fetchImpl(args.url);
      return { content: [{ type: 'text', text: `${page.url} (${page.status})${page.truncated ? ' [cut at 2 MB]' : ''}\n\n${page.text}` }], details: undefined };
    } };
}
