const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { QueueStore } = require('./queue.cjs');
const S = require('./storage.cjs');
const M = require('./media.cjs');
const FF = require('./frame-filter.cjs');
const FC = require('./frame-filter-config.cjs');
const {preparationReserve}=require('./preparation-reserve.cjs');
const R = require('./recovery.cjs');
const GB = 1024 ** 3;
// Footage Farm screeners are normally far below 256 MiB. Reserve one such
// allowance per active preparation plus one publication slot. The 30-second
// live usage guard remains the hard backstop. The former 512 MiB allowance per
// slot stranded several gigabytes and could halt a healthy producer just below
// its configured ceiling.
const admissionReserveBytes = concurrency => (Math.max(1, Math.min(8, Number(concurrency) || 1)) + 1) * 256 * 1024 * 1024;
// Older tests and pre-migration live snapshots expose only `bytes`. New
// snapshots separate durable evidence from the working set so retained hits and
// provider holds cannot permanently block a limit that cleanup cannot satisfy.
const guardedBytes = usage => Number.isFinite(usage?.guardBytes) ? usage.guardBytes : Number(usage?.bytes || 0);
async function treeBytes(folder, io = fs, seenFiles = new Set(), options = {}) {
  let bytes = 0;
  for (const item of await R.retryIO(() => io.readdir(folder, { withFileTypes: true })).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    const file = path.join(folder, item.name); if (item.isSymbolicLink()) throw new Error('Managed footage folder contains a link. Check its contents before continuing.');
    if (item.isDirectory()) bytes += await treeBytes(file, io, seenFiles, options);
    else if (item.isFile()) {
      // Cleanup, publication and atomic JSON writes can remove/rename an entry
      // after readdir. A live size estimate must tolerate only that disappearance.
      let stat;
      try { stat = await R.retryIO(() => io.lstat(file, { bigint: true })); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      if (stat.isSymbolicLink()) throw new Error('Managed footage folder contains a link. Check its contents before continuing.');
      if (stat.isFile()) {
        // Different stories from one reel use NTFS hard links while they are
        // being prepared concurrently. Count their shared bytes once; counting
        // every directory entry as a separate MP4 can trip the storage guard
        // even though the filesystem stores only one copy.
        const hasIdentity = typeof stat.ino === 'bigint' ? stat.ino !== 0n : !!stat.ino;
        const identity = hasIdentity ? `${stat.dev}:${stat.ino}` : null;
        if (identity && seenFiles.has(identity)) continue;
        if (identity) seenFiles.add(identity);
        // When measuring a deletion, a hard-linked file consumes no less disk
        // until its final link is removed. This keeps "reclaimed" physical,
        // instead of reporting the same reel once for every story link.
        const links = stat.nlink == null ? 1 : Number(stat.nlink);
        if (!options.lastLinkOnly || links <= 1) {
          const size = Number(stat.size);
          bytes += size;
          options.onBytes?.(file, size);
        }
      }
      else if (stat.isDirectory()) bytes += await treeBytes(file, io, seenFiles, options);
    }
  }
  return bytes;
}
// Only explicit artifacts created by this pipeline can be recursively removed.
async function ownedRemove(root, relative, token) {
  const canonical = await fs.realpath(root), target = path.resolve(canonical, relative), rel = path.relative(canonical, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !/^(frames[\\/][a-z0-9-]+|\.pipeline[\\/](media|staging)[\\/][a-z0-9-]+)$/.test(rel)) throw new Error('Cleanup refused a path outside a managed video folder.');
  if (!(await S.exists(target))) return 0;
  const parts = rel.split(path.sep); let check = canonical;
  for (const part of parts) { check = path.join(check, part); if ((await fs.lstat(check)).isSymbolicLink()) throw new Error('Cleanup refused a linked folder.'); }
  if (await fs.realpath(target) !== target) throw new Error('Cleanup target is not the expected real path.');
  const marker = await S.readJson(path.join(target, '.reelsight-owned.json'), null);
  const identity = await fs.lstat(target, { bigint: true });
  const intentPath = path.join(canonical, '.pipeline', 'cleanup', `${S.sha(relative)}.json`);
  const intent = await S.readJson(intentPath, null);
  // Recursive deletion can remove the marker and then hit a locked child.
  // The durable intent is valid only for the exact directory file ID previously
  // checked, never for a replacement folder that happens to use the same name.
  const resuming = !marker && identity.ino !== 0n && intent?.token === token && intent?.relative === relative && intent?.ino === String(identity.ino) && intent?.dev === String(identity.dev);
  if (!resuming && (marker?.token !== token || marker?.relative !== relative)) throw new Error('Cleanup refused a folder without matching ownership.');
  if (!resuming) await S.atomicJson(intentPath, { token, relative, ino: String(identity.ino), dev: String(identity.dev), started_at: new Date().toISOString() });
  const bytes = await treeBytes(target, fs, new Set(), { lastLinkOnly: true });
  await fs.rm(target, { recursive: true, force: false, maxRetries: 6, retryDelay: 100 });
  await R.retryIO(() => fs.rm(intentPath, { force: true })); return bytes;
}
async function pruneHitCards(root, id, token, keepNames) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Hit-card cleanup refused an invalid video ID.');
  const keep = new Set([...keepNames].filter(name => /^card_\d+\.jpg$/.test(name)));
  if (!keep.size) throw new Error('Hit-card cleanup requires at least one saved evidence card.');
  const folder = path.join(root, 'frames', id), relative = `frames/${id}`;
  if (!(await S.exists(folder))) return 0;
  const marker = await S.readJson(path.join(folder, '.reelsight-owned.json'), null);
  if (marker?.token !== token || marker?.relative !== relative) throw new Error('Hit-card cleanup refused a folder without matching ownership.');
  const cards = path.join(folder, 'cards');
  let reclaimed = 0;
  for (const item of await fs.readdir(cards, { withFileTypes: true })) {
    if (!item.isFile() || !/^card_\d+\.jpg$/.test(item.name)) throw new Error('Hit-card cleanup found an unexpected cards-folder entry.');
    if (keep.has(item.name)) continue;
    const file = path.join(cards, item.name), stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Hit-card cleanup refused a linked or non-file card.');
    await R.retryIO(() => fs.rm(file, { force: false })); reclaimed += stat.size;
  }
  for (const name of keep) if (!(await S.exists(path.join(cards, name)))) throw new Error(`Saved hit evidence card is missing: ${name}`);
  return reclaimed;
}
class PreparationPipeline extends EventEmitter {
  constructor({ tools, media = M, frameFilter, getFrameFilter = () => ({enabled:false}), getReviewLoad = () => ({}) }) {
    super(); this.tools = tools; this.media = media; this.running = false; this.stopping = false;
    this.frameFilter = frameFilter; this.getFrameFilter = getFrameFilter;
    this.getReviewLoad=getReviewLoad;this.minimumBuffer=3;
    this.state = { status: 'idle', message: 'Import a URL collection to begin.', current: null, counts: {}, recent: [], bytes: 0, guardBytes: 0, footageBytes: 0, cardBytes: 0, workingCardBytes: 0, retainedCardBytes: 0, reclaimed: 0 };
    this.judgedIds = new Set(); this.hitIds = new Set(); this.deferredIds = new Set(); this.manualDeferredIds = new Set(); this.cleanupRetries = new Map(); this.preparationRetries = new Map(); this.reviewId = null; this.reviewIds = new Set(); this.target = 3;
    this.wakeWaiters = new Set(); this.sourceClaims = new Map(); this.mediaClaims = new Map(); this.resolvedAhead = null; this.extractingId = null; this.extractingIds = new Set();
  }
  backlog() {
    this.target=preparationReserve(this.minimumBuffer,this.getReviewLoad());
    const unique = new Map();
    const reviewKey = row => row.media_key?.startsWith('segment:') ? row.media_key : row.source_hash || row.id;
    for (const row of this.store?.readyReels() || []) {
      if (this.judgedIds.has(row.id) || this.deferredIds.has(row.id)) continue;
      const key = reviewKey(row);
      if (!unique.has(key)) unique.set(key, row);
    }
    const all = [...unique.values()];
    const activeKeys = new Set([...this.reviewIds].map(id => this.store?.get(id)).filter(Boolean).map(reviewKey));
    const ahead = all.filter(row => !activeKeys.has(reviewKey(row)));
    return { target: this.target, ready_reels: all.length, ahead_reels: ahead.length, ahead_cards: ahead.reduce((n,r)=>n+(r.card_count||0),0), ahead_frames: ahead.reduce((n,r)=>n+(r.frame_count||0),0), reviewing: this.reviewId, reviewing_ids: [...this.reviewIds], reviewing_reels: activeKeys.size };
  }
  setReviewId(id) { this.setReviewIds(id ? [id] : []); }
  setReviewIds(ids) { const next = new Set(ids); if ([...next].join(',') === [...this.reviewIds].join(',')) return; this.reviewIds = next; this.reviewId = [...next][0] || null; this.update(); this.notifyWork(); }
  setDeferredIds(ids) { this.setDeferredItems(ids.map(id => ({ id, manual: false }))); }
  setDeferredItems(items) {
    const deferred = new Set(items.map(item => String(item.id)));
    const manual = new Set(items.filter(item => item.manual).map(item => String(item.id)));
    if ([...deferred].join(',') === [...this.deferredIds].join(',') && [...manual].join(',') === [...this.manualDeferredIds].join(',')) return;
    this.deferredIds = deferred; this.manualDeferredIds = manual; this.update(); this.notifyWork();
    this.syncVerdicts().catch(error => this.audit({ event: 'manual-hold-cleanup-failed', error: error.message, error_code: error.code }).catch(()=>{}));
  }
  notifyWork() { for (const wake of this.wakeWaiters) wake(); this.wakeWaiters.clear(); }
  waitForWork(ms = 1000) {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.wakeWaiters.add(finish);
    });
  }
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  progress(changes = {}) {
    // ffmpeg and concurrent downloaders can report dozens of progress events
    // per second. Keep the newest values, but perform the SQLite summary,
    // atomic live-file write and renderer notification at most four times/sec.
    Object.assign(this.state, changes);
    if (this.progressTimer) return;
    const delay = Math.max(0, 250 - (Date.now() - (this.lastProgressUpdate || 0)));
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.lastProgressUpdate = Date.now();
      this.update();
    }, delay);
    this.progressTimer.unref?.();
  }
  update(changes = {}) {
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = null; }
    Object.assign(this.state, changes); if (this.store) { this.state.counts = this.store.counts(); this.state.recent = this.store.recent(); this.state.backlog = this.backlog(); }
    const snapshot = this.snapshot(); this.emit('state', snapshot);
    if(this.root) { const root=this.root; this.liveWrite=(this.liveWrite||Promise.resolve()).catch(()=>{}).then(()=>S.atomicJson(path.join(root,'logs','prepare_live.json'),{updated_at:new Date().toISOString(),...snapshot})); }
    this.liveWrite?.catch(error => { this.state.logError = error.message; });
  }
  async open(root) {
    if (this.root === root && this.store) return;
    if (this.running) throw new Error('Pause footage preparation before changing projects.');
    this.store?.close(); this.root = root; this.judgedIds = new Set(); this.hitIds = new Set(); this.deferredIds = new Set(); this.manualDeferredIds = new Set(); this.cleanupRetries.clear(); this.preparationRetries.clear(); this.reviewId = null; this.reviewIds = new Set();
    this.wakeWaiters.clear(); this.sourceClaims = new Map(); this.mediaClaims = new Map(); this.resolvedAhead = null; this.extractingId = null; this.extractingIds = new Set();
    await fs.mkdir(path.join(root, 'frames'), { recursive: true });
    await fs.mkdir(path.join(root, 'logs'), { recursive: true });
    const ownerPath = path.join(root, '.pipeline', 'owner.json');
    const owner = await S.readJson(ownerPath, null); this.token = owner?.token || crypto.randomUUID();
    if (!owner) await S.atomicJson(ownerPath, { token: this.token, created_at: new Date().toISOString() });
    this.store = new QueueStore(root);
    const unavailable=this.store.classifyPreviewUnavailable();
    const footageRetries=this.store.retryLegacyFootageFarmFailures();
    this.update({ status: 'idle', message: footageRetries?`${footageRetries} Footage Farm downloads queued for the improved resolver.`:unavailable?`${unavailable} catalog records separated because Footage Farm requires a requested preview.`:'Footage queue ready.', current: null, ...await this.usage() });
  }
  setActiveSource(key) { if (!this.store) throw new Error('Create or choose a workspace first.'); if (this.running) throw new Error('Pause preparation before switching sources.'); this.store.setActiveSource(key); this.update({ activeSource:key, sources:this.store.sourcesList(), message:`Source switched to ${this.store.sourcesList().find(s=>s.key===key)?.label||'all imported URLs'}.` }); this.notifyWork(); return this.snapshot(); }
  async import(file, options) { if (!this.store) throw new Error('Create or choose a workspace first.'); if (this.running) throw new Error('Pause preparation before importing more URLs.'); const result = this.store.import(file,options);this.store.setActiveSource(result.sourceKey); this.update({ activeSource:result.sourceKey,sources:this.store.sourcesList(),message: `${result.added.toLocaleString()} URLs imported; ${result.alreadyPresent.toLocaleString()} already present.` }); return result; }
  async markFolder(relative) {
    const folder = path.join(this.root, relative);
    if (await S.exists(folder)) {
      let owner = await S.readJson(path.join(folder, '.reelsight-owned.json'), null);
      // An interrupted first write can leave the newly-created staging folder
      // completely empty, before its ownership marker exists. Reclaim only
      // that exact harmless state; any content in an unowned folder is kept for
      // inspection instead of being guessed at or deleted recursively.
      if (!owner && relative.startsWith('.pipeline/staging/') && (await fs.readdir(folder)).length === 0) {
        await fs.rmdir(folder);
        await fs.mkdir(folder);
        await S.atomicJson(path.join(folder, '.reelsight-owned.json'), { token: this.token, relative });
        owner = { token: this.token, relative };
        await this.audit({ event: 'recovered-empty-unowned-staging', id: path.basename(relative), relative });
      }
      let publishing = false;
      if (relative.startsWith('.pipeline/staging/') && owner?.token === this.token && owner.relative === `frames/${path.basename(relative)}`) {
        const receipt = await S.readJson(path.join(folder,'prepared.json'), null);
        publishing = receipt?.token === this.token && receipt.id === path.basename(relative);
      }
      if (owner?.token !== this.token || (owner?.relative !== relative && !publishing)) throw new Error('An existing folder is not owned by this preparation queue. It has been preserved.');
    } else { await fs.mkdir(folder, { recursive: true }); await S.atomicJson(path.join(folder, '.reelsight-owned.json'), { token: this.token, relative }); }
    return folder;
  }
  async usage() {
    const seenFiles = new Set();
    let footageBytes = 0; for (const dir of ['media','staging']) footageBytes += await treeBytes(path.join(this.root, '.pipeline', dir), fs, seenFiles);
    const frames = path.join(this.root, 'frames');
    const retainedIds = new Set([...this.hitIds, ...this.manualDeferredIds]);
    let retainedCardBytes = 0;
    const cardBytes = await treeBytes(frames, fs, seenFiles, { onBytes: (file, size) => {
      const relative = path.relative(frames, file);
      const id = relative.split(path.sep)[0];
      if (id && retainedIds.has(id)) retainedCardBytes += size;
    } });
    retainedCardBytes = Math.min(cardBytes, retainedCardBytes);
    const workingCardBytes = Math.max(0, cardBytes - retainedCardBytes);
    // The configurable limit controls media that preparation can reclaim or
    // replace. Durable hit evidence and explicit manual-review holds remain
    // visible and are protected by the real free-space guard instead of causing
    // a permanent cleanup loop.
    const guardBytes = footageBytes + workingCardBytes;
    const bytes = footageBytes + cardBytes;
    const stat = await fs.statfs(this.root); return { bytes, guardBytes, footageBytes, cardBytes, workingCardBytes, retainedCardBytes, free: Number(stat.bavail) * Number(stat.bsize) };
  }
  async audit(event) { await fs.appendFile(path.join(this.root, 'logs', 'prepare_events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'); }
  pause() { this.stopping = true; this.controller?.abort(); this.update({ status: 'pausing', message: 'Pausing preparation; downloaded work is retained.' }); }
  async syncVerdicts() {
    this.syncAgain = true;
    if (this.syncTask) return this.syncTask;
    this.syncTask = (async () => { do { this.syncAgain = false; await this._syncVerdicts(); } while (this.syncAgain); })();
    try { return await this.syncTask; } finally { this.syncTask = null; }
  }
  unusableStoryRange(error) {
    return error === 'Story time range is invalid or outside the downloaded reel. Nothing published.'
      || error === 'Hungarian story has no valid start/end range. Refusing to substitute the entire reel.'
      || /^Coverage check failed: \d+ frames \/ expected \d+–\d+, \d+ cards\./.test(error||'');
  }
  async _reclaimFailedPreparation(row) {
    const key = `fail:${row.id}`;
    if ((this.cleanupRetries.get(key)?.next || 0) > Date.now()) return 0;
    try {
      const targets = [`.pipeline/media/${row.id}`, `.pipeline/staging/${row.id}`];
      let reclaimed = 0;
      for (const relative of targets) reclaimed += await ownedRemove(this.root, relative, this.token);
      if (reclaimed) {
        this.store.update(row.id, { bytes: 0 });
        await this.audit({ event: 'cleaned-failed-preparation', id: row.id, reclaimed_bytes: reclaimed, error: row.error, targets });
        this.state.reclaimed += reclaimed;
      }
      this.cleanupRetries.delete(key);
      return reclaimed;
    } catch (e) {
      const attempts = (this.cleanupRetries.get(key)?.attempts || 0) + 1;
      const next = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
      this.cleanupRetries.set(key, { attempts, next });
      await this.audit({ event: 'cleanup-deferred', id: row.id, error: e.message, error_code: e.code, attempts, next_retry_at: next, reason: 'failed-preparation' });
      return 0;
    }
  }
  async _retirePublishedSource(row, reason = 'cards-published', trackReclaimed = true) {
    const current = this.store.get(row.id) || row;
    // Aliases own only a tiny descriptor and reuse their owner's durable source
    // identity. They never own the source directory being retired here.
    if (current.owner_id && current.owner_id !== current.id) {
      if (current.bytes) this.store.update(current.id, { bytes: 0 });
      return 0;
    }
    const key = `published:${current.id}`;
    if ((this.cleanupRetries.get(key)?.next || 0) > Date.now()) return 0;
    try {
      const frameReceiptPath = path.join(this.root, 'frames', current.id, 'prepared.json');
      const durableReceiptPath = path.join(this.root, '.pipeline', 'receipts', `${current.id}.json`);
      const receipt = await S.readJson(frameReceiptPath, null);
      if (!receipt || receipt.token !== this.token || receipt.id !== current.id || receipt.shared_from) throw new Error('Published card receipt is unavailable or does not own this source. Source preserved.');
      const mediaRelative = `.pipeline/media/${current.id}`, stagingRelative = `.pipeline/staging/${current.id}`;
      const hasTemporarySource = await S.exists(path.join(this.root, mediaRelative)) || await S.exists(path.join(this.root, stagingRelative));
      if (!hasTemporarySource && receipt.source_retired === true && typeof receipt.card_signature === 'string' && receipt.card_signature) {
        if (current.bytes) this.store.update(current.id, { bytes: 0 });
        this.cleanupRetries.delete(key);
        return 0;
      }
      const cards = receipt.cards?.map(card => path.join(this.root, 'frames', current.id, 'cards', card.name));
      if (!Array.isArray(cards) || !cards.length) throw new Error('Published card coverage is unavailable. Source preserved.');
      const cardSignature = await S.fingerprintCards({ cards });
      if (receipt.card_signature && receipt.card_signature !== cardSignature) throw new Error('Published cards changed after preparation. Source preserved.');
      const mp4 = typeof receipt.mp4 === 'string' ? path.resolve(this.root, receipt.mp4) : null;
      if (mp4 && await S.exists(mp4)) {
        const fingerprint = await S.fingerprintVideo({ prepared: receipt, cards, mp4, expectedFingerprint: receipt.source_fingerprint, scope: receipt.scope, segment_start: receipt.segment_start, segment_end: receipt.segment_end });
        if (fingerprint !== receipt.source_fingerprint) throw new Error('Published source identity no longer matches its receipt. Source preserved.');
      }
      // These two receipts are the authorization for card-only review after the
      // MP4 is gone. Write both before deletion so a crash can never leave an
      // unverified card set masquerading as intentionally retired footage.
      const retiredReceipt = { ...receipt, card_signature: cardSignature, source_retired: true, source_retired_at: receipt.source_retired_at || new Date().toISOString() };
      await S.atomicJson(durableReceiptPath, retiredReceipt);
      await S.atomicJson(frameReceiptPath, retiredReceipt);
      const targets = [mediaRelative, stagingRelative];
      let reclaimed = 0;
      for (const relative of targets) reclaimed += await ownedRemove(this.root, relative, this.token);
      this.store.update(current.id, { bytes: 0 });
      if (reclaimed) {
        if (trackReclaimed) this.state.reclaimed += reclaimed;
        await this.audit({ event: 'retired-published-source', id: current.id, reason, source_fingerprint: receipt.source_fingerprint, card_signature: cardSignature, reclaimed_bytes: reclaimed, targets, retained: [`frames/${current.id}`, `receipts/${current.id}.json`] });
      }
      this.cleanupRetries.delete(key);
      return reclaimed;
    } catch (e) {
      const attempts = (this.cleanupRetries.get(key)?.attempts || 0) + 1;
      const next = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
      this.cleanupRetries.set(key, { attempts, next });
      await this.audit({ event: 'cleanup-deferred', id: current.id, reason, error: e.message, error_code: e.code, attempts, next_retry_at: next });
      return 0;
    }
  }
  async _reclaimStoragePressure() {
    // A storage-guard abort returns unfinished work to pending. Its partial
    // source cannot make progress while the guard is blocked, so retaining it
    // can deadlock the cleanup that is meant to free that same space. Error
    // rows remain retryable and will download again. Older cleaned rows may
    // also contain source folders left by an interrupted cleanup.
    let reclaimed = 0;
    for (const status of ['ready','hit','cleaned','pending','error']) for (const row of this.store.all(status)) {
      if (this.reviewIds.has(row.id)) continue;
      if (status === 'ready') {
        reclaimed += await this._retirePublishedSource(row, 'storage-pressure', false);
        continue;
      }
      const targets = [`.pipeline/media/${row.id}`, `.pipeline/staging/${row.id}`];
      let rowBytes = 0;
      try {
        for (const relative of targets) rowBytes += await ownedRemove(this.root, relative, this.token);
        if (rowBytes) {
          reclaimed += rowBytes;
          this.store.update(row.id, { bytes: 0 });
          await this.audit({ event: 'storage-pressure-cleanup', id: row.id, status, reclaimed_bytes: rowBytes, targets, retained: ['queue record','receipts','verdicts','published review cards'] });
        }
      } catch (e) {
        await this.audit({ event: 'cleanup-deferred', id: row.id, reason: 'storage-pressure', error: e.message, error_code: e.code, targets });
      }
    }
    if (reclaimed) this.state.reclaimed += reclaimed;
    return reclaimed;
  }
  cleanupNow() {
    if (!this.cleanupTask) this.cleanupTask = this._cleanupNow().finally(() => { this.cleanupTask = null; });
    return this.cleanupTask;
  }
  async _cleanupNow() {
    if (!this.store || !this.root) throw new Error('Create or choose a workspace first.');
    this.update({ message: 'Checking published receipts and cleaning temporary source footage…' });
    // An operator-requested cleanup is also the recovery path for a guard that
    // is waiting behind an automatic retry delay. Keep the ownership and
    // durable-receipt checks in the normal cleanup routines; only bypass their
    // in-memory backoff so every eligible item is attempted now.
    for (const retry of this.cleanupRetries.values()) retry.next = 0;
    const reclaimedBefore = this.state.reclaimed;
    await this.syncVerdicts();
    await this._reclaimStoragePressure();
    const usage = await this.usage();
    const reclaimed = Math.max(0, this.state.reclaimed - reclaimedBefore);
    await this.audit({ event: 'manual-media-cleanup', reclaimed_bytes: reclaimed, bytes_remaining: usage.bytes, guard_bytes_remaining: usage.guardBytes, retained_card_bytes: usage.retainedCardBytes });
    this.update({
      bytes: usage.bytes, guardBytes: usage.guardBytes, footageBytes: usage.footageBytes, cardBytes: usage.cardBytes, workingCardBytes: usage.workingCardBytes, retainedCardBytes: usage.retainedCardBytes, free: usage.free,
      message: reclaimed
        ? `Media cleanup reclaimed ${Math.max(1, Math.round(reclaimed / 1024 / 1024)).toLocaleString()} MB. Preparation can resume automatically.`
        : 'Media cleanup checked every eligible item; no disposable source footage remains. Saved cards are retained.'
    });
    this.notifyWork();
    return { reclaimed, bytes: usage.bytes, state: this.snapshot() };
  }
  async _syncVerdicts() {
    if (!this.store) return;
    // A manual provider/source hold only needs its published contact sheets and
    // durable journal. Keeping the downloaded source for every hold eventually
    // consumes the entire workspace cap and cannot help manual classification.
    for (const id of this.manualDeferredIds) {
      if (this.reviewIds.has(id)) continue;
      const row = this.store.get(id);
      if (!row || !['ready','error'].includes(row.status)) continue;
      const key = `manual:${id}`;
      if ((this.cleanupRetries.get(key)?.next || 0) > Date.now()) continue;
      try {
        const relative = `.pipeline/media/${id}`;
        const reclaimed = await ownedRemove(this.root, relative, this.token);
        if (reclaimed) {
          this.store.update(id, { bytes: 0 });
          this.state.reclaimed += reclaimed;
          await this.audit({ event: 'cleaned-manual-hold-media', id, reclaimed_bytes: reclaimed, retained: [`frames/${id}`, 'deferred-journal'] });
        }
        this.cleanupRetries.delete(key);
      } catch (e) {
        const attempts = (this.cleanupRetries.get(key)?.attempts || 0) + 1;
        const next = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
        this.cleanupRetries.set(key, { attempts, next });
        await this.audit({ event: 'cleanup-deferred', id, reason: 'manual-hold-media', error: e.message, error_code: e.code, attempts, next_retry_at: next });
      }
    }
    for (const row of this.store.all('error')) {
      if (this.reviewIds.has(row.id) || !this.unusableStoryRange(row.error)) continue;
      if (await S.exists(path.join(this.root, 'frames', row.id))) continue;
      await this._reclaimFailedPreparation(row);
    }
    // The producer never writes a classification. It only consumes durable receipts.
    const { entries } = await S.loadLedger(this.root), map = new Map(entries.map(e => [String(e.id), e]));
    this.judgedIds = new Set(entries.filter(e=>['no','jewish','filtered_no'].includes(e.verdict)).map(e=>String(e.id)));
    this.hitIds = new Set(entries.filter(e=>e.verdict==='jewish').map(e=>String(e.id)));
    for (const row of [...this.store.all('ready'), ...this.store.all('no'), ...this.store.all('filtered_no'), ...this.store.all('hit')]) {
      if (this.reviewIds.has(row.id)) continue;
      const verdict = map.get(row.id); if (!verdict || !['jewish','no','filtered_no'].includes(verdict.verdict)) continue;
      if ((this.cleanupRetries.get(row.id)?.next || 0) > Date.now()) continue;
      try {
      const receipt = await S.readJson(path.join(this.root, '.pipeline','receipts',`${row.id}.json`), null);
      if (!receipt || receipt.token !== this.token) throw new Error('Durable cleanup receipt unavailable or ownership does not match. Media preserved.');
      if (verdict.verdict === 'jewish') {
        // The published cards are the durable visual evidence for a hit. The
        // downloaded source and any staging copy are redundant after the
        // preparation receipt and verdict exist, and retaining them for every
        // hit eventually deadlocks the storage guard.
        const targets = row.owner_id === row.id ? [`.pipeline/media/${row.id}`, `.pipeline/staging/${row.id}`] : [];
        let reclaimed = 0;
        for (const relative of targets) reclaimed += await ownedRemove(this.root, relative, this.token);
        const evidenceCards = new Set([verdict.evidence?.card, ...(verdict.evidence_hits || []).map(hit => hit?.card)].filter(Boolean));
        if (row.owner_id === row.id) reclaimed += await pruneHitCards(this.root, row.id, this.token, evidenceCards);
        this.store.update(row.id, { status: 'hit', bytes: 0, error: null });
        if (reclaimed) {
          this.state.reclaimed += reclaimed;
          await this.audit({ event: 'cleaned-confirmed-hit-media', id: row.id, source_fingerprint: receipt.source_fingerprint, reclaimed_bytes: reclaimed, targets, retained_cards: [...evidenceCards], retained: ['receipt', 'verdict and evidence'] });
        }
        this.cleanupRetries.delete(row.id);
        continue;
      }
      const filteredCoverage = verdict.verdict==='filtered_no' && await FF.verifiedCompletion(this.root,verdict,receipt);
      const fullCoverage = verdict.verdict!=='filtered_no' && Array.isArray(verdict.cards_reviewed) && new Set(verdict.cards_reviewed).size === receipt.card_count && verdict.cards_total === receipt.card_count && receipt.cards.every(c => verdict.cards_reviewed.includes(c.name));
      const original = map.get(String(verdict.copied_from));
      const shared = verdict.method === 'shared-reel-copy' && (original?.verdict === 'no' || (original?.verdict==='filtered_no' && filteredCoverage && original.filter?.key===verdict.filter?.key)) && original.source_fingerprint === receipt.source_fingerprint && (row.owner_id === row.id || String(verdict.copied_from) === row.owner_id);
      if (entries.some(e => e.verdict === 'jewish' && e.source_fingerprint === receipt.source_fingerprint)) { this.store.update(row.id, { error: 'This source also has a hit verdict. Media preserved for reconciliation.' }); continue; }
      if (verdict.source_fingerprint !== receipt.source_fingerprint || (row.owner_id !== row.id ? !shared : (!fullCoverage && !filteredCoverage && !shared))) {
        this.store.update(row.id, { error: 'Saved no has no matching complete coverage receipt. Media preserved.' }); continue;
      }
      this.store.update(row.id, { status: verdict.verdict==='filtered_no'?'filtered_no':'no', error: null });
      // An alias owns only its small published descriptor; its owner's assets are handled separately.
      const targets = row.owner_id === row.id ? [`frames/${row.id}`, `.pipeline/media/${row.id}`, `.pipeline/staging/${row.id}`] : [`frames/${row.id}`];
        let reclaimed = 0;
        for (const relative of targets) reclaimed += await ownedRemove(this.root, relative, this.token);
        this.store.update(row.id, { status: 'cleaned', bytes: 0 });
        await this.audit({ event: verdict.verdict==='filtered_no'?'cleaned-completed-filtered-no':'cleaned-completed-no', id: row.id, source_fingerprint: receipt.source_fingerprint, reclaimed_bytes: reclaimed, targets });
        this.state.reclaimed += reclaimed;
        this.cleanupRetries.delete(row.id);
      } catch (e) {
        const attempts = (this.cleanupRetries.get(row.id)?.attempts || 0) + 1;
        const next = Date.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5));
        this.cleanupRetries.set(row.id, { attempts, next });
        this.store.update(row.id, { error: `Cleanup pending; automatic retry: ${e.message}` });
        await this.audit({ event: 'cleanup-deferred', id: row.id, error: e.message, error_code: e.code, attempts, next_retry_at: next });
      }
    }
    this.update();
  }
  async screenPrepared(row, receipt, directory) {
    if(receipt.shared_from)return;
    let config;
    do {
      config=FC.normalize(this.getFrameFilter());if(!config.enabled)return;
      if(!this.frameFilter)throw FF.fail('The local People model is unavailable. Reinstall this build and retry preparation.');
      this.store.update(row.id,{status:'screening',error:null});
      this.update({status:'running',current:{id:row.id,stage:'screening',screened:0,total:receipt.frame_count,localWorkers:this.frameFilter.workerCount},message:`Screening people locally for ${row.id} before AI review…`});
      const video={id:row.id,prepared:receipt,cards:receipt.cards.map(c=>path.join(directory,'cards',c.name)),mp4:path.resolve(this.root,receipt.mp4),expectedFingerprint:receipt.source_fingerprint,scope:receipt.scope,segment_start:receipt.segment_start,segment_end:receipt.segment_end};
      const result=await this.frameFilter.screen({root:this.root,video,config,reusePrepared:true,...(directory===path.join(this.root,'.pipeline','staging',row.id)?{artifactDirectory:directory}:{}),sourceFingerprint:await S.fingerprintVideo(video),cardSignature:await S.fingerprintCards(video),stopped:()=>this.stopping||this.controller?.signal.aborted,onProgress:p=>{this.emit('screening',p);this.progress({current:{id:row.id,stage:'screening',...p,parallelVideos:Math.max(1,this.extractingIds.size)},message:`${row.id} · people screening ${p.screened}/${p.total} · ${p.selected} whole frames selected`});}});
      await this.audit({event:'people-screening-ready',id:row.id,manifest:result.manifest_path,fingerprint:result.fingerprint,screened:result.frame_count,selected:result.selected_count,skipped:result.frame_count-result.selected_count,elapsed_ms:result.elapsed_ms,local_workers:result.local_workers||0,reused:!!result.prepared});
    } while(JSON.stringify(config)!==JSON.stringify(FC.normalize(this.getFrameFilter())));
  }
  async publish(row, receipt) {
    await S.atomicJson(path.join(this.root,'.pipeline','receipts',`${row.id}.json`), receipt);
    const relative = `frames/${row.id}`, final = path.join(this.root, relative);
    if (await S.exists(final)) {
      const old = await S.readJson(path.join(final,'prepared.json'), null);
      if (old?.token === this.token && old.source_fingerprint === receipt.source_fingerprint) { await this.screenPrepared(row,old,final); this.store.update(row.id, { status: 'ready',error:null }); await this._retirePublishedSource(this.store.get(row.id), 'cards-republished'); this.emit('ready',{id:row.id}); return; }
      throw new Error('Existing published card folder differs from the prepared reel; preserved for inspection.');
    }
    const stage = path.join(this.root,'.pipeline','staging',row.id);
    // Rename publishes all cards atomically; the consumer never sees half-built sheets.
    await S.atomicJson(path.join(stage,'prepared.json'), receipt);
    await S.atomicJson(path.join(stage,'.reelsight-owned.json'), { token: this.token, relative });
    await this.screenPrepared(row,receipt,stage);
    if(this.stopping||this.controller?.signal.aborted)throw new Error('Preparation paused. Screened frames are retained.');
    await R.retryIO(() => fs.rename(stage, final));
    this.store.update(row.id, { status: 'ready', frame_count: receipt.frame_count, card_count: receipt.card_count, duration: receipt.duration });
    await this.audit({ event: 'cards-ready', id: row.id, frames: receipt.frame_count, cards: receipt.card_count, shared_from: receipt.shared_from || null });
    await this._retirePublishedSource(this.store.get(row.id), 'cards-published');
    this.emit('ready', { id: row.id });
  }
  prefetchResolve(exceptId) {
    if (this.stopping || this.resolvedAhead || !this.controller || !this.store) return;
    const next = this.store.next();
    if (!next || next.id === exceptId) return;
    const promise = this.media.resolveMedia(next.url, this.controller.signal);
    this.resolvedAhead = { id: next.id, promise };
    promise.catch(() => { if (this.resolvedAhead?.id === next.id) this.resolvedAhead = null; });
  }
  async resolveRow(row, signal) {
    if (this.resolvedAhead?.id === row.id) {
      const pending = this.resolvedAhead;
      try { return await pending.promise; }
      catch { /* A failed prefetch must not skip a live resolve. */ }
      finally { if (this.resolvedAhead === pending) this.resolvedAhead = null; }
    }
    return this.media.resolveMedia(row.url, signal);
  }
  async copyCachedSource(resolved, row, target) {
    for (const source of this.store.sources(resolved.url, row.id)) {
      const cached = path.join(this.root, '.pipeline', 'media', source.owner_id || source.id, 'source.mp4');
      if (!(await S.exists(cached))) continue;
      try {
        // Stories from one newsreel use the exact same immutable source bytes.
        // A hard link publishes those bytes instantly and lets each story clean
        // up its own directory without copying and hashing hundreds of MB again.
        try { await fs.link(cached, target + '.part'); }
        catch (e) {
          if (!['EPERM','EACCES','EXDEV','ENOTSUP'].includes(e.code)) throw e;
          await fs.copyFile(cached, target + '.part');
          if (await S.hashFile(target + '.part') !== source.source_hash) throw new Error('Cached source hash changed; refusing to associate it with this story.');
        }
        await fs.rename(target + '.part', target);
        await this.audit({ event: 'source-download-reused', id: row.id, from: source.owner_id || source.id, scope: resolved.scope, segment_start: resolved.segment_start, segment_end: resolved.segment_end });
        return true;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    return false;
  }
  async publishAlias(row, resolved, mediaKey) {
    const shared = resolved.direct ? this.store.shared(mediaKey, row.id) : null;
    if (!shared) return false;
    const source = await S.readJson(path.join(this.root, '.pipeline', 'receipts', `${shared.id}.json`), null);
    if (!source || source.token !== this.token) throw new Error('Shared-reel receipt missing. Resolve its preparation first.');
    this.store.update(row.id, { owner_id: shared.id, source_hash: shared.source_hash });
    await this.publish(row, { ...source, id: row.id, title: row.title, url: row.url, shared_from: shared.id, shared_basis: resolved.scope === 'segment' ? 'same resolved MP4 and identical story time range' : 'same resolved whole-reel media URL', segment_start: resolved.segment_start, segment_end: resolved.segment_end });
    return true;
  }
  async acquireSource(row, opts) {
    const signal = this.controller.signal;
    const existing=await S.readJson(path.join(this.root,'frames',row.id,'prepared.json'),null);
    if(existing?.token===this.token&&existing.id===row.id){await this.publish(row,existing);return null;}
    this.store.update(row.id, { status: 'resolving', attempts: row.attempts + 1, error: null });
    if (!this.extractingId) this.update({ current: { id: row.id, stage: 'resolving' }, message: `Resolving ${row.id}…` });
    const resolved = await this.resolveRow(row, signal), mediaKey = resolved.scope === 'segment' ? 'segment:' + S.sha(JSON.stringify([resolved.url, resolved.segment_start, resolved.segment_end])) : S.sha(resolved.url);
    if (!/^https?:\/\//i.test(resolved.url)) throw new Error('Resolved media must be an HTTP(S) resource.');
    this.store.update(row.id, { media_url: resolved.url, media_key: mediaKey });
    this.prefetchResolve(row.id);
    if (await this.publishAlias(row, resolved, mediaKey)) return null;
    while(this.mediaClaims.has(mediaKey)){
      await this.mediaClaims.get(mediaKey);
      if(this.stopping)throw new Error('Preparation paused. Partial work is saved.');
      if(await this.publishAlias(row,resolved,mediaKey))return null;
    }
    let settleMedia;const mediaPending=new Promise(resolve=>{settleMedia=resolve;});this.mediaClaims.set(mediaKey,mediaPending);
    const releaseMedia=()=>{if(this.mediaClaims.get(mediaKey)===mediaPending)this.mediaClaims.delete(mediaKey);settleMedia();};
    while (this.sourceClaims.has(resolved.url)) {
      await this.sourceClaims.get(resolved.url);
      if (this.stopping) throw new Error('Preparation paused. Partial work is saved.');
      if (await this.publishAlias(row, resolved, mediaKey)) return null;
    }
    let settle;
    const pending = new Promise(resolve => { settle = resolve; });
    this.sourceClaims.set(resolved.url, pending);
    const releaseSource = () => {
      if (this.sourceClaims.get(resolved.url) === pending) this.sourceClaims.delete(resolved.url);
      settle();
    };
    try {
      const stage = await this.markFolder(`.pipeline/staging/${row.id}`);
      const folder = await this.markFolder(`.pipeline/media/${row.id}`);
      this.store.update(row.id, { status: 'downloading', owner_id: row.id });
      if (!this.extractingId) this.update({ current: { id: row.id, stage: 'downloading' }, message: `Downloading ${row.id}…` });
      // Reuse a downloaded MP4 without reusing another story's verdict or cards.
      // Each different segment owns its source copy, so normal no cleanup is safe.
      const target = path.join(folder, 'source.mp4');
      if (!(await S.exists(target))) await this.copyCachedSource(resolved, row, target);
      this.prefetchResolve(row.id);
      const file = await this.media.download(resolved, folder, this.tools, { signal, maxBytes: Math.min(8 * GB, opts.maxGB * GB / 2), onProgress: p => { if (!this.extractingId) this.progress({ current: { id: row.id, stage: 'downloading', ...p } }); } });
      // Expose a verified source to other stories from this reel before extraction.
      const hash=await S.hashFile(file),bytes=(await fs.stat(file)).size;
      this.store.update(row.id,{source_hash:hash,bytes});releaseSource();
      return { row, resolved, file, stage, hash, releaseMedia };
    } catch (error) {
      releaseSource();
      releaseMedia();
      throw error;
    }
  }
  async extractAndPublish(job, opts) {
    const { row, resolved, file, stage, releaseSource } = job;
    const signal = this.controller.signal;
    this.extractingIds.add(row.id);this.extractingId=this.extractingIds.values().next().value||null;
    try {
      this.store.update(row.id, { status: 'extracting' });
      this.update({ current: { id: row.id, stage: 'extracting' }, message: `Building complete ${opts.fps} fps cards for ${row.id}…` });
      // A paused extraction is regenerated in a private, owned stage; finished source media is reused.
      const cardFolder = path.join(stage, 'cards');
      if (await S.exists(cardFolder)) {
        for (const name of await fs.readdir(cardFolder)) { if (!/^card_\d+\.jpg$/.test(name)) throw new Error('Unexpected file in unfinished cards folder.'); const card = path.join(cardFolder, name); if (!(await fs.lstat(card)).isFile()) throw new Error('Unexpected card link or folder.'); await fs.unlink(card); }
      }
      const coverage = await this.media.makeCards(file, cardFolder, this.tools, { signal, fps: opts.fps, width: opts.width, ...(resolved.scope === 'segment' ? { segment_start: resolved.segment_start, segment_end: resolved.segment_end } : {}), onProgress: p => this.progress({ current: { id: row.id, stage: 'extracting', ...p } }) });
      const hash = job.hash || await S.hashFile(file), bytes = (await fs.stat(file)).size;
      this.store.update(row.id, { source_hash: hash, bytes });
    await this.publish(row, { ...coverage, id: row.id, title: row.title, url: row.url, source_key:this.store.activeSource, token: this.token, mp4: path.relative(this.root, file), media_url: resolved.url, scope: resolved.scope || 'whole-reel', source_fingerprint: S.mediaFingerprint(hash, resolved), prepared_at: new Date().toISOString(), segment_start: resolved.segment_start, segment_end: resolved.segment_end });
    } finally {
      this.extractingIds.delete(row.id);this.extractingId=this.extractingIds.values().next().value||null;
      releaseSource?.();
      job.releaseMedia?.();
    }
  }
  async prepare(row, opts) {
    const job = await this.acquireSource(row, opts);
    if (job) await this.extractAndPublish(job, opts);
  }
  async run(options = {}) {
    if (this.running || !this.store) throw new Error('Select a workspace with a preparation queue first.');
    const opts = { buffer: Number(options.buffer || 3), fps: Number(options.fps || 1), width: Number(options.width || 960), maxGB: Number(options.maxGB || 20) };
    if (!Number.isInteger(opts.buffer) || opts.buffer < 1 || opts.buffer > 64 || ![1,2,4].includes(opts.fps) || ![640,960,1280].includes(opts.width) || opts.maxGB < 2 || opts.maxGB > 1000) throw new Error('Invalid preparation limits.');
    this.minimumBuffer=opts.buffer;this.target=opts.buffer=preparationReserve(this.minimumBuffer,this.getReviewLoad());
    this.running = true; this.stopping = false; this.controller = new AbortController();
    this.sourceClaims = new Map(); this.mediaClaims = new Map(); this.resolvedAhead = null; this.extractingId = null; this.extractingIds = new Set();
    let guard, guardTask, checking = false, diskError = null, unlock, active=new Map();
    try {
      unlock = await S.acquireLock(this.root, 'prepare.lock'); this.store.recover();
      // Reclaim artifacts rejected by older coverage validation before putting
      // them back in the queue; otherwise they can fill the disk guard and
      // prevent their own corrected retry from ever starting.
      await this.syncVerdicts();
      const correctedGeometryRetries = this.store.retryCorrectedGeometryFailures();
      if (correctedGeometryRetries) await this.audit({ event: 'corrected-contact-sheet-geometry-retried', videos: correctedGeometryRetries });
      await this.audit({event:'backfill-started',target_reels:opts.buffer,fps:opts.fps,width:opts.width,max_gb:opts.maxGB});
      // Local model screening no longer competes for CPU and memory. Keep more
      // independent downloads/extractions in flight so a 128-worker reviewer is
      // not starved while waiting for its next prepared reel.
      const preparationConcurrency=Math.max(1,Math.min(8,Number(this.getReviewLoad().videoConcurrency)||1));
      const admissionReserve=admissionReserveBytes(preparationConcurrency);
      const storageError=()=>Object.assign(new Error('Storage guard is waiting for cleanup before preparing more footage.'),{storageLimit:true});
      this.update({preparationConcurrency,message:`Preparing up to ${preparationConcurrency} videos concurrently.`});
      let bufferFull = false,lastMaintenance=0,lastUsage=await this.usage();
      const startActive=row=>{
        // Claim synchronously before starting the async work so another loop
        // iteration cannot select the same pending row.
        this.store.update(row.id,{status:'resolving',error:null});
        const promise=this.prepare(row,opts).then(()=>({id:row.id,row}),error=>({id:row.id,row,error}));
        active.set(row.id,promise);promise.finally(()=>this.notifyWork());
      };
      // A full ownership-aware scan is intentionally infrequent: on a large
      // workspace it competes with downloads and FFmpeg. Admission reserve and
      // download byte limits provide the fast-path protection between scans.
      guard = setInterval(() => { if (checking || this.stopping || diskError) return; checking = true; guardTask = (async () => { try { const use=lastUsage=await this.usage(); this.update({ bytes: use.bytes, guardBytes: use.guardBytes, footageBytes: use.footageBytes, cardBytes: use.cardBytes, workingCardBytes: use.workingCardBytes, retainedCardBytes: use.retainedCardBytes, free: use.free }); if (guardedBytes(use) > opts.maxGB * GB || use.free < 2 * GB) { diskError = storageError(); this.controller.abort(); } } catch (e) { diskError = e; this.controller.abort(); } finally { checking = false; } })(); }, 30000);
      const recoveryWait = async error => {
        this.update({ status: 'running', current: null, message: `File access temporarily unavailable (${error.code}). Preparation waits 15s and retries automatically; existing reviews can continue.` });
        await this.audit({ event: 'preparation-file-retry', error: error.message, error_code: error.code });
        for (let i = 0; i < 15 && !this.stopping; i++) await R.sleep(1000);
      };
      const failRow = async (row, e) => {
        if (!row) throw e;
        if (this.stopping || diskError) { this.store.update(row.id, { status: 'pending' }); return 'stop'; }
        if (e.code === 'PREVIEW_UNAVAILABLE') {
          this.store.update(row.id, { status: 'unavailable', error: e.message });
          await this.audit({ event: 'source-preview-unavailable', id: row.id, error: e.message, error_code: e.code });
          this.update(); return 'continue';
        }
        const sourceRetry = e.sourceTransient === true && row.attempts < 12;
        const retry = R.lockCodes.has(e.code) || e.code === 'ENOENT' || sourceRetry;
        const next = retry ? Date.now() + Math.min(300000, 15000 * 2 ** Math.min(row.attempts, 5)) : null;
        if (retry) this.preparationRetries.set(row.id, next);
        this.store.update(row.id, { status: 'error', error: retry ? `${sourceRetry ? 'Source' : 'File access'} retry: ${e.message}` : e.message });
        await this.audit({ event: retry ? 'preparation-deferred' : 'preparation-error', id: row.id, error: e.message, error_code: e.code, next_retry_at: next });
        if (!retry && this.unusableStoryRange(e.message)) await this._reclaimFailedPreparation(this.store.get(row.id));
        this.update();
        await this.waitForWork(1000);
        return 'continue';
      };
      const settleOne=async()=>{
        if(!active.size)return null;
        const outcome=await Promise.race(active.values());active.delete(outcome.id);
         if(outcome.error)await failRow(outcome.row,outcome.error);
        return outcome;
      };
      const settleAll=async()=>{while(active.size)await settleOne();};
      // File-access errors survive restart in the queue's error text. Ordinary
      // invalid URLs are left for explicit retry rather than a hot retry loop.
      for (const row of this.store.all('error')) if (/^(File access|Source) retry:/.test(row.error || '')) this.preparationRetries.set(row.id, Date.now());
      let warmedConfig=null;
      while (!this.stopping) {
        this.target=opts.buffer=preparationReserve(this.minimumBuffer,this.getReviewLoad());
        if (diskError) {
          await settleAll();
          if (diskError.storageLimit) {
            await this.syncVerdicts();
            await this._reclaimStoragePressure();
            lastUsage = await this.usage();
            if (guardedBytes(lastUsage) + admissionReserve < opts.maxGB * GB && lastUsage.free >= 3 * GB) {
              await this.audit({ event: 'storage-guard-resumed', bytes: lastUsage.bytes, guard_bytes: guardedBytes(lastUsage), retained_card_bytes: lastUsage.retainedCardBytes, reserve_bytes: admissionReserve });
              diskError = null; this.controller = new AbortController(); continue;
            }
            this.update({ status: 'running', current: null, bytes: lastUsage.bytes, guardBytes: lastUsage.guardBytes, footageBytes: lastUsage.footageBytes, cardBytes: lastUsage.cardBytes, workingCardBytes: lastUsage.workingCardBytes, retainedCardBytes: lastUsage.retainedCardBytes, free: lastUsage.free, message: 'Working media reached the configured limit. Temporary footage is being cleaned; saved hit and manual-review cards do not block preparation.' });
            await this.waitForWork(2000); continue;
          }
          if (!R.lockCodes.has(diskError.code)) throw diskError;
          await recoveryWait(diskError); if (this.stopping) break;
          diskError = null; this.controller = new AbortController();
        }
        let usage=lastUsage;
        try { if(Date.now()-lastMaintenance>=5000){await this.syncVerdicts();lastMaintenance=Date.now();} }
        catch (e) { diskError=e;this.controller.abort();continue; }
        this.update({ bytes: usage.bytes, guardBytes: usage.guardBytes, footageBytes: usage.footageBytes, cardBytes: usage.cardBytes, workingCardBytes: usage.workingCardBytes, retainedCardBytes: usage.retainedCardBytes, free: usage.free });
        if (guardedBytes(usage) + admissionReserve >= opts.maxGB * GB || usage.free < 3 * GB) {diskError=storageError();this.controller.abort();continue;}
        const warmConfig=JSON.stringify(FC.normalize(this.getFrameFilter()));
        if(warmedConfig!==warmConfig){
          warmedConfig=warmConfig;
          if(FC.normalize(this.getFrameFilter()).enabled)for(const row of this.store.all('ready')){
            if(this.stopping)break;
            if(row.owner_id!==row.id||this.judgedIds.has(row.id)||this.deferredIds.has(row.id)||this.reviewIds.has(row.id))continue;
            try{const receipt=await S.readJson(path.join(this.root,'frames',row.id,'prepared.json'),null);if(!receipt||receipt.token!==this.token)throw FF.fail('Preparation receipt unavailable. Retry preparation.');await this.screenPrepared(row,receipt,path.join(this.root,'frames',row.id));this.store.update(row.id,{status:'ready',error:null});this.emit('ready',{id:row.id});}
            catch(e){await failRow(row,e);}
          }
          if(this.stopping)break;
        }
        for (const [id, next] of this.preparationRetries) if (next <= Date.now()) { this.store.update(id, { status: 'pending', error: null }); this.preparationRetries.delete(id); }
        const backlog = this.backlog();
        if (backlog.ahead_reels >= opts.buffer) {
          if(active.size){await settleOne();continue;}
          if (!bufferFull) await this.audit({event:'backfill-full',...this.backlog()});
          bufferFull = true;
          this.update({ status: 'buffered', current: null, message: `${this.backlog().ahead_reels} distinct clips ready ahead. Refilling automatically as review takes a clip.` });
          await this.waitForWork(1000); continue;
        }
        if (bufferFull || !this.backlog().ahead_reels) await this.audit({event:'backfill-refilling',...this.backlog()});
        bufferFull = false;
        this.update({ status: 'running', message: `Refilling reserve: ${this.backlog().ahead_reels} / ${opts.buffer} distinct clips ahead.` });
        let started=false;
        while(active.size<preparationConcurrency && this.backlog().ahead_reels+active.size<opts.buffer){
          const row=this.store.next();if(!row)break;startActive(row);started=true;
        }
        if(active.size>=preparationConcurrency || (!started&&active.size)){await settleOne();continue;}
        if(!active.size){if(this.preparationRetries.size){this.update({status:'running',current:null,message:'Waiting to retry temporarily inaccessible preparation files…'});await this.waitForWork(1000);continue;}break;}
      }
      await settleAll();
      this.update({ status: this.stopping ? 'paused' : 'complete', current: null, message: this.stopping ? 'Preparation paused. Source files and partial work retained.' : 'URL queue prepared. Any source errors are listed below for retry.' });
    } catch (e) { this.controller?.abort();if(active.size){for(const outcome of await Promise.all(active.values()))this.store.update(outcome.row.id,{status:'pending'});active.clear();}this.update({ status: 'error', message: e.message }); await this.audit({ event: 'preparation-stopped', error: e.message, error_code: e.code, current: this.state.current }).catch(()=>{}); }
    // A previous run's disk scan must finish before another run can start.
    finally {
      clearInterval(guard); await guardTask;
      try { if(unlock)await unlock(); }
      catch (e) { this.update({ status: 'error', message: `Work retained, but the preparation lock could not be released: ${e.message}` }); }
      finally { this.running = false; this.update(); }
    }
    return this.snapshot();
  }
}
module.exports = { PreparationPipeline, ownedRemove, treeBytes, admissionReserveBytes, guardedBytes };
