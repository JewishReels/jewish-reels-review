// FIFO permits cover a region's retries, verification and saved result.
// Sequential mode has one owner; concurrent mode has one per selected worker.
class RequestGate {
  constructor({ workers, mode = 'one-at-a-time', onChange = () => {}, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), baseDelayMs = 4000, maxDelayMs = 30000, spacingMs = 500 }) {
    if (!['one-at-a-time', 'concurrent'].includes(mode)) throw new Error('Choose Take turns or Run concurrently.');
    Object.assign(this, { workers, mode, onChange, now, sleep, baseDelayMs, maxDelayMs, spacingMs: mode === 'concurrent' ? 0 : spacingMs });
    this.limit = mode === 'concurrent' ? workers : 1; this.active = 0; this.inFlight = 0; this.until = 0; this.nextStart = 0; this.waves = 0; this.cleanResponses = 0; this.cleanSinceThrottle = 0; this.queue = []; this.slots = new Set(); this.owners = new Map(); this.ownerTurns = new Map(); this.turn = 0;
  }
  snapshot() { return { mode: this.mode, until: this.until, reason: this.reason, effectiveWorkers: this.limit, requestedWorkers: this.workers, spacingMs: this.spacingMs, nextStart: this.nextStart }; }
  cooldown(delay, reason = 'connection') {
    const deadline = this.now() + delay;
    if (deadline >= this.until) { this.until = deadline; this.reason = reason; }
    this.onChange(this.snapshot()); return Math.max(0, this.until - this.now());
  }
  cooling() { return this.now() < this.until; }
  throttle(retryAfterMs = 0) {
    const hint = Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0;
    if (this.mode === 'concurrent') {
      // OpenRouter can return an isolated upstream 429 while many sibling
      // requests continue to succeed. Treating that as a pool-wide incident
      // repeatedly collapsed a 128-worker run to one request at a time. Delay
      // only the rejected image; healthy requests keep the selected capacity.
      this.onChange(this.snapshot());
      return Math.max(this.baseDelayMs, hint);
    }
    const now = this.now();
    const newWave = now >= this.until;
    if (newWave) {
      this.waves++;
      this.cleanResponses = 0;
      this.cleanSinceThrottle = 0;
      if (this.mode === 'concurrent' && this.inFlight > 0) this.limit = Math.max(1, Math.floor(this.limit / 2));
    }
    const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.min(20, this.waves - 1));
    return this.cooldown(Math.max(backoff, hint), 'rate-limit');
  }
  nextTicket() {
    // Give videos with fewer occupied slots priority, then rotate on ties.
    // FIFO is preserved within each video (and for callers with no owner).
    const byOwner = new Map(); for (const ticket of this.queue) if (!byOwner.has(ticket.owner)) byOwner.set(ticket.owner, ticket);
    const first = [...byOwner.values()];
    const minimum = Math.min(...first.map(t => this.owners.get(t.owner) || 0));
    const candidates = first.filter(t => (this.owners.get(t.owner) || 0) === minimum);
    return candidates.sort((a,b) => (this.ownerTurns.get(a.owner) || 0) - (this.ownerTurns.get(b.owner) || 0))[0];
  }
  async acquire(stopped, owner = null) {
    const ticket = { owner }; this.queue.push(ticket);
    try {
    while (!stopped()) {
      if (this.active < this.limit && this.nextTicket() === ticket) {
        this.queue.splice(this.queue.indexOf(ticket), 1); this.active++;
        this.ownerTurns.set(owner, ++this.turn); this.owners.set(owner, (this.owners.get(owner) || 0) + 1);
        let workerId = 1; while (this.slots.has(workerId)) workerId++;
        this.slots.add(workerId);
        let released = false;
        const release = () => { if (!released) { released = true; this.active--; this.slots.delete(workerId); const count = this.owners.get(owner) - 1; if (count) this.owners.set(owner, count); else this.owners.delete(owner); } };
        release.workerId = workerId; return release;
      }
      await this.sleep(50);
    }
    return null;
    } finally { const index = this.queue.indexOf(ticket); if (index >= 0) this.queue.splice(index, 1); }
  }
  async begin(stopped) {
    // A job keeps its ownership permit across retries, but every provider call
    // needs a separate send slot. This lets a 429 reduce the retry wave instead
    // of allowing all pre-throttle owners to resend at the same instant.
    while (!stopped()) {
      const remaining = Math.max(this.until, this.nextStart) - this.now();
      if (remaining <= 0 && this.inFlight < this.limit) { this.inFlight++; return true; }
      await this.sleep(remaining > 0 ? Math.min(200, remaining) : 50);
    }
    return false;
  }
  finished({ success = false } = {}) {
    if (this.inFlight > 0) this.inFlight--;
    if (this.mode === 'one-at-a-time') this.nextStart = this.now() + this.spacingMs;
    if (success && this.mode === 'concurrent' && !this.cooling() && this.limit < this.workers) {
      // Additive recovery avoids another synchronized 128-request retry wave.
      if (++this.cleanResponses >= 8) { this.limit++; this.cleanResponses = 0; }
    }
    if (success && !this.cooling() && ++this.cleanSinceThrottle >= 16) {
      // Backoff waves describe one rate-limit incident. Once the provider has
      // completed a sustained clean run, a later isolated 429 starts again at
      // the short cooldown instead of inheriting a permanent 30-second delay.
      this.waves = 0;
      this.cleanSinceThrottle = 0;
    }
    this.onChange(this.snapshot());
  }
}
module.exports = { RequestGate };
