import { randomBytes, timingSafeEqual } from 'node:crypto';

// A startup secret for the Pi event bus of one process, so that a package which loads later (an extension the member added) cannot speak as
// the harness, the sandbox or the provider. THIS FILE IS IDENTICAL in piagent-harness, piagent-sandbox and piagent-provider (src/bus-nonce.mjs).
//
// How it travels: the harness loads first and makes the secret. Each of the other two packages asks for it once, while it loads
// (`piagent:nonce.claim`, answered through the request's own `reply` function, never broadcast); a second claim for the same name is
// ignored. Messages that change state (run.state, permission.mode, tools.attest, studio.call, grant.request/close, tools.child, run.process)
// then carry `nonce`. Limit: this is first-come at startup, not authentication. Code that runs before the harness, or that reads this
// process's memory, defeats it; it holds against an extension loaded after the three packages, which is the order the launcher sets
// with --no-extensions and -e. The harness blocks every tool call if the handshake did not complete.
const CLAIM = 'piagent:nonce.claim';
const stores = new WeakMap();

export function serveNonce(events, names = ['sandbox', 'provider']) {
  const state = { nonce: randomBytes(24).toString('hex'), pending: new Set(names) };
  stores.set(events, state);
  events.on(CLAIM, data => { if (typeof data?.reply === 'function' && state.pending.delete(data.who)) data.reply({ v: 1, nonce: state.nonce }); });
  return { complete: () => state.pending.size === 0, missing: () => [...state.pending] };
}
export function claimNonce(events, who) {
  let nonce = null;
  try { events.emit(CLAIM, { v: 1, who, reply: answer => { if (typeof answer?.nonce === 'string') nonce = answer.nonce; } }); } catch { /* no harness */ }
  if (nonce) stores.set(events, { nonce, pending: new Set() });
  return nonce;
}
export const nonceOf = events => stores.get(events)?.nonce ?? null;
export const withNonce = (events, payload) => { const nonce = nonceOf(events); return nonce ? { ...payload, nonce } : payload; };
// True when this process has no secret (development) or the message carries it.
export function nonceOk(events, data) {
  const nonce = nonceOf(events);
  if (!nonce) return true;
  const given = typeof data?.nonce === 'string' ? data.nonce : '';
  return given.length === nonce.length && timingSafeEqual(Buffer.from(given), Buffer.from(nonce));
}
