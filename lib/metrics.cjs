const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

// Responses occur in several logs. Count each generation/request only once;
// prefer provider costs over estimates, including unsuccessful reviews.
class UsageLedger {
  constructor(root) {
    this.root = root; this.records = new Map(); this.aliases = new Map();
    this.total = 0; this.estimates = 0; this.skipped = 0; this.writes = Promise.resolve();
    this.unknownCosts = new Set();
  }
  ingest(record, fallback) {
    if (!record || typeof record !== 'object') return;
    const keys = [record.generation && `g:${record.generation}`, record.request_id && `r:${record.request_id}`].filter(Boolean);
    const key = keys.map(k => this.aliases.get(k)).find(Boolean) || keys[0] || fallback;
    if (record.billing_uncertain === true || (record.event === 'request_failed' && record.billing_uncertain === undefined)) this.unknownCosts.add(key);
    if (typeof record.cost !== 'number' || !Number.isFinite(record.cost) || record.cost < 0) return;
    this.unknownCosts.delete(key); for (const alias of keys) this.unknownCosts.delete(alias);
    const old = this.records.get(key);
    for (const alias of keys) this.aliases.set(alias, key);
    if (old && (!old.estimated || record.estimated)) return;
    if (old) { this.total -= old.cost; this.estimates -= Number(old.estimated); }
    const value = { cost: record.cost, estimated: !!record.estimated };
    this.records.set(key, value); this.total += value.cost; this.estimates += Number(value.estimated);
  }
  async load() {
    for (const name of ['reelsight_transport.jsonl', 'reelsight_reviews.jsonl', 'reelsight_usage.jsonl']) {
      const file = path.join(this.root, 'logs', name);
      try { await fsp.access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      let lineNumber = 0;
      for await (const line of lines) {
        lineNumber++; if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { this.skipped++; continue; }
        this.ingest(record, `${name}:${lineNumber}`);
      }
    }
    return this;
  }
  record(data) {
    const record = { at: new Date().toISOString(), ...data, request_id: data.request_id || (data.generation ? undefined : randomUUID()) };
    this.ingest(record, record.request_id);
    // Serialize appends; concurrent responses must not overwrite one another.
    this.writes = this.writes.then(() => fsp.appendFile(path.join(this.root, 'logs', 'reelsight_usage.jsonl'), JSON.stringify(record) + '\n'));
    return this.writes;
  }
  snapshot() { return { totalSpend: this.total, totalEstimated: this.estimates > 0, costLogSkipped: this.skipped, unknownCostAttempts: this.unknownCosts.size }; }
}

class ReviewClock {
  constructor(now = Date.now) { this.now = now; this.elapsed = 0; this.started = null; this.completed = 0; this.reused = 0; }
  setActive(active) {
    if (active && this.started === null) this.started = this.now();
    if (!active && this.started !== null) { this.elapsed += Math.max(0, this.now() - this.started); this.started = null; }
  }
  finish(reused) { this.completed++; if (reused) this.reused++; }
  snapshot() {
    const processingMs = this.elapsed + (this.started === null ? 0 : Math.max(0, this.now() - this.started));
    return { processingMs, processingActive: this.started !== null, sessionVideos: this.completed, sessionReused: this.reused,
      videosPerMinute: processingMs > 0 ? this.completed * 60000 / processingMs : 0, metricsAt: this.now() };
  }
}
module.exports = { UsageLedger, ReviewClock };
