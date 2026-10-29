
// One approval of the member: Pi's own prompt (ctx.ui.confirm). A command the member declined is not
// asked again by the check that would repeat it: the denial is remembered per conversation.
export class Approvals {
  #declined = new Set();
  async request(ctx, { key, title, body }, signal) {
    if (this.#declined.has(key)) throw new Error('managed-operation-denied');
    if (signal?.aborted) throw new Error('managed-tool-cancelled');
    const allowed = await (ctx?.ui?.confirm?.(title, body) ?? false);
    if (!allowed || signal?.aborted) { this.#declined.add(key); throw new Error('managed-operation-denied'); }
  }
  forget() { this.#declined.clear(); }
}
