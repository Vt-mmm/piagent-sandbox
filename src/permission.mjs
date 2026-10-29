import { handoffReason, mustConfirm } from './handoff-policy.mjs';

// Access of a conversation, chosen by the member and kept with it:
// ask     (Ask first): asks before every command that leaves the sandbox;
// full    (Full access): asks only about the handoff and what is destructive (mustConfirm);
// bypass  (Bypass): runs the work and asks only about the handoff (handoffReason), where the Harness allows it.
// The sandbox stays in every mode: Bypass removes questions, not the boundary.
export const MODES = ['ask', 'full', 'bypass'];
export const ENTRY = 'piagent-permission';

export class Permission {
  #mode = 'ask'; #bypassAllowed = false;
  constructor({ onChange = () => {}, persist = () => {} } = {}) { this.onChange = onChange; this.persist = persist; }
  // Only an explicit yes from the Harness: without it Bypass falls back to Full access.
  allowBypass(allowed) {
    const before = this.mode;
    this.#bypassAllowed = allowed === true;
    if (before !== this.mode) this.onChange(this.mode);
  }
  get bypassAllowed() { return this.#bypassAllowed; }
  get mode() { return this.#mode === 'bypass' && !this.#bypassAllowed ? 'full' : this.#mode; }
  restore(entries) {
    const last = entries.filter(e => e.type === 'custom' && e.customType === ENTRY).at(-1)?.data?.mode;
    this.#mode = MODES.includes(last) ? last : 'ask';
    this.onChange(this.mode);
  }
  set(mode) {
    if (!MODES.includes(mode)) throw new Error('managed-permission-unavailable');
    if (mode === 'bypass' && !this.#bypassAllowed) throw new Error('managed-bypass-unavailable');
    this.#mode = mode;
    this.persist({ mode, at: new Date().toISOString() });
    this.onChange(this.mode);
  }
  get asksOnlyHandoff() { return this.mode === 'bypass'; }
  get broadAccess() { return this.mode !== 'ask'; }
  // Why a command that leaves the sandbox must be asked about: the reason, 'ask' in Ask first, or null to run it.
  confirmation(command) {
    if (this.mode === 'bypass') return handoffReason(command);
    if (this.mode === 'full') return mustConfirm(command);
    return 'ask';
  }
}
