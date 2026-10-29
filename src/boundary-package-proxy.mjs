import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DEFAULT_DOMAINS, PackageProxy, mavenSettings, memberDomains } from './package-proxy.mjs';

// Starts the package proxy for a boundary: a Unix socket on Linux (the worker forwards 127.0.0.1:3128
// to it inside the command's network namespace), a loopback port on macOS. `options` reach the proxy.
export async function startBoundaryPackageProxy(boundary, apply, options = {}) {
  // A per-run secret on macOS, where the proxy listens on a loopback port any local process can reach.
  const secret = boundary.linux ? null : randomBytes(16).toString('hex');
  boundary.proxy = new PackageProxy({ domains: [...DEFAULT_DOMAINS, ...memberDomains(boundary.domainsFile)], secret, ...options });
  try {
    let url;
    if (boundary.linux) {
      // The socket lives in a folder only this user can enter.
      boundary.proxySocketDir = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-proxy-'));
      fs.chmodSync(boundary.proxySocketDir, 0o700);
      boundary.proxySocket = path.join(boundary.proxySocketDir, 'proxy.sock');
      await boundary.proxy.listen(boundary.proxySocket);
      url = 'http://127.0.0.1:3128';
    } else url = `http://piagent:${secret}@127.0.0.1:${(await boundary.proxy.listen()).port}`;
    const settings = path.join(boundary.home, '.m2/settings.xml');
    fs.mkdirSync(path.dirname(settings), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings, mavenSettings(url), { mode: 0o600 });
    boundary.proxyUrl = url;
    apply();
  } catch { await boundary.proxy.close().catch(() => {}); boundary.proxy = null; }
}
