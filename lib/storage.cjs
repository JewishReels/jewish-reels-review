const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const R = require('./recovery.cjs');

const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function exists(p) { try { await R.retryIO(() => fs.access(p)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readJson(p, fallback) {
  try { return JSON.parse(await R.retryIO(() => fs.readFile(p, 'utf8'))); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw Object.assign(new Error(`Cannot read ${path.basename(p)}: ${e.message}`, { cause: e }), { code: e.code, path: p }); }
}
async function atomicJson(p, value, { rename = fs.rename, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  await R.retryIO(() => fs.mkdir(path.dirname(p), { recursive: true }));
  const tmp = `${p}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const h = await R.retryIO(() => fs.open(tmp, 'wx'));
  try { await h.writeFile(JSON.stringify(value) + '\n'); await h.sync(); } finally { await h.close(); }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(tmp, p); break; }
      catch (error) {
        // Windows may briefly hold the destination while another reader opens
        // it. Keep the old file intact and retry the same atomic replacement.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
        await sleep(Math.min(1000, 50 * 2 ** attempt));
      }
    }
  } catch (e) { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; }
}
function decodeLedger(raw) {
  if (Array.isArray(raw)) return { entries: raw, encode: entries => entries };
  if (raw && typeof raw === 'object') {
    for (const key of ['verdicts', 'results']) {
      if (Array.isArray(raw[key])) return { entries: raw[key], encode: entries => ({ ...raw, [key]: entries }) };
    }
    const pairs = Object.entries(raw);
    if (pairs.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.verdict === 'string')) {
      return {
        entries: pairs.map(([k, v]) => ({ ...v, id: v.id ?? k })),
        // Keep the legacy keyed representation while IDs are unique. A
        // superseded decision and its replacement intentionally share an ID;
        // switch to the ordinary array envelope then so neither audit record
        // can be overwritten by an object key collision.
        encode: entries => new Set(entries.map(v => String(v.id))).size === entries.length
          ? Object.fromEntries(entries.map(v => [String(v.id), v]))
          : { verdicts: entries }
      };
    }
  }
  throw new Error('Unrecognized chat_verdicts.json format. Expected an array, {verdicts: [...]}, {results: [...]}, or an ID-keyed object. The file has not been changed.');
}
async function loadLedger(root) {
  const raw = await readJson(path.join(root, 'chat_verdicts.json'), []);
  const decoded = decodeLedger(raw);
  if (decoded.entries.some(e => !e || e.id === undefined || typeof e.verdict !== 'string')) throw new Error('A verdict record is missing an id or verdict. Repair the existing file before reviewing.');
  return { ...decoded, history: decoded.entries, entries: activeEntries(decoded.entries) };
}
function activeEntries(entries) { return entries.filter(entry => !entry?.superseded_at); }
async function backupLedger(root, p) {
  if (!(await exists(p))) return;
  const backup = path.join(root, 'logs', 'chat_verdicts.before-reelsight.json');
  await fs.mkdir(path.dirname(backup), { recursive: true });
  try { await fs.copyFile(p, backup, require('node:fs').constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}
async function loadMetadata(root) {
  // Optional metadata is kept in the controller, never sent to a model.
  const raw = await readJson(path.join(root, 'reelsight_manifest.json'), []);
  const values = Array.isArray(raw) ? raw : (Array.isArray(raw.videos) ? raw.videos : Object.entries(raw).map(([id, v]) => ({ ...v, id: v.id ?? id })));
  const map = new Map();
  for (const v of values) if (v && v.id !== undefined) map.set(String(v.id), v);
  return map;
}
async function discover(selected, { skipIds = new Set(), sourceKey = null } = {}) {
  let root = await R.retryIO(() => fs.realpath(selected));
  if (path.basename(root).toLowerCase() === 'frames') root = path.dirname(root);
  const frames = path.join(root, 'frames');
  if (!(await exists(frames))) throw new Error('Choose the project folder containing frames/<id>/cards/card_*.jpg, or choose its frames folder.');
  const ledger = await loadLedger(root);
  const meta = await loadMetadata(root);
  const dirs = (await R.retryIO(() => fs.readdir(frames, { withFileTypes: true }))).filter(d => d.isDirectory()).sort((a, b) => natural(a.name, b.name));
  // A selected import source is a complete workspace view. Verdicts and
  // completion from another source must not hide, count, or populate this one.
  const current = ledger.entries;
  const entries = sourceKey ? current.filter(e => e.source_key === sourceKey) : current;
  const judged = new Map(entries.filter(e => ['no','jewish','filtered_no'].includes(e.verdict)).map(e => [String(e.id), e]));
  const owner = await readJson(path.join(root, '.pipeline', 'owner.json'), null);
  const videos = [], issues = [], recoveries = [];
  const scopeIds = sourceKey
    ? new Set([...meta.values()].filter(value => value?.source_key === sourceKey).map(value => String(value.id)))
    : null;
  for (const d of dirs) {
    // A durable verdict owns completion. Its temporary folder may be in the
    // middle of cleanup; touching prepared.json again is both wasteful and racy.
    if (skipIds.has(d.name) || judged.get(d.name)?.source_fingerprint) continue;
    const manifest = meta.get(d.name) || {};
    let resolvedSourceKey = manifest.source_key;
    if (sourceKey && resolvedSourceKey && resolvedSourceKey !== sourceKey) continue;
    try {
    // Establish source membership before validating cards. A damaged receipt
    // from an inactive source must remain recorded for that source, but it must
    // not appear as INPUT_UNAVAILABLE in the source currently being reviewed.
    let prepared, readError;
    try { prepared = await readJson(path.join(frames, d.name, 'prepared.json'), null); } catch (e) { readError = e; }
    const marker = await readJson(path.join(frames, d.name, '.reelsight-owned.json'), null);
    const managed = !!marker || !!prepared?.token || (owner && /^fho-\d+$/.test(d.name));
    if ((!prepared || readError) && managed) {
      prepared = await readJson(path.join(root, '.pipeline', 'receipts', `${d.name}.json`), null);
      if (!prepared) throw readError || R.inputError('Prepared metadata and its durable receipt are unavailable. Waiting for preparation to finish.');
      recoveries.push({ id: d.name, event: 'prepared-receipt-fallback', error_code: readError?.code || 'ENOENT' });
    } else if (readError) throw readError;
    const m = prepared || manifest;
    resolvedSourceKey = m.source_key;
    if (sourceKey && resolvedSourceKey !== sourceKey) continue;
    if (scopeIds) scopeIds.add(d.name);
    const cardsDir = path.join(frames, d.name, 'cards');
    let names;
    try { names = (await R.retryIO(() => fs.readdir(cardsDir, { withFileTypes: true }))).filter(f => f.isFile() && /^card_.*\.jpe?g$/i.test(f.name)).map(f => f.name).sort(natural); }
    catch (e) { if (e.code === 'ENOENT') names = []; else throw e; }
    if (managed) {
      if (!owner?.token || marker?.token !== owner.token || marker?.relative !== `frames/${d.name}` || prepared?.token !== owner.token || prepared?.id !== d.name) throw R.inputError('Prepared receipt ownership or video ID does not match. Keeping this video pending.');
      if (!['segment','whole-reel'].includes(prepared.scope) || !prepared.source_fingerprint) throw R.inputError('Prepared receipt is missing source identity or story scope.');
      if (prepared.scope === 'segment') mediaFingerprint('validation', prepared);
      const expected = prepared.cards?.map(c => c.name);
      if (!Array.isArray(expected) || !expected.length || expected.length !== prepared.card_count || new Set(expected).size !== expected.length || expected.some(n => typeof n !== 'string' || !/^card_[\w-]+\.jpe?g$/i.test(n))) throw R.inputError('Prepared receipt has invalid card coverage.');
      if (!prepared.shared_from && JSON.stringify([...expected].sort(natural)) !== JSON.stringify(names)) throw R.inputError('Published cards do not match complete prepared coverage. Keeping this video pending.');
    }
    if (!names.length && !m.shared_from) continue;
    if (m.shared_from && !entries.some(e => String(e.id) === String(m.shared_from) && e.source_fingerprint === m.source_fingerprint && ['jewish','no','filtered_no'].includes(e.verdict))) continue;
    videos.push({ prepared: prepared || null, id: d.name, cards: names.map(name => path.join(cardsDir, name)), title: String(m.title || ''), url: String(m.url || ''), mp4: typeof m.mp4 === 'string' ? path.resolve(root, m.mp4) : null, expectedFingerprint: managed ? m.source_fingerprint : null, sharedFrom: m.shared_from, sharedFingerprint: m.shared_from ? m.source_fingerprint : null, mediaUrl: m.media_url || '', scope: m.scope, segment_start: m.segment_start, segment_end: m.segment_end });
    } catch (e) {
      // An already judged legacy ID is only an optional deduplication source.
      // Its unreadable files must not hold up unjudged videos either.
      const sourceMatches = !sourceKey || resolvedSourceKey === sourceKey;
      if (sourceMatches && !judged.has(d.name)) issues.push({ id: d.name, source_key: sourceKey || resolvedSourceKey, message: e.message, code: e.code || 'INPUT_UNAVAILABLE', path: e.path });
    }
  }
  return {
    root,
    videos,
    entries,
    // The active source scopes preparation, progress, and new model review.
    // Saved-hit browsing is workspace-wide, so keep the already-loaded hit
    // records available without rereading the large verdict ledger.
    workspaceHits: current.filter(entry => entry.verdict === 'jewish'),
    sourceKey,
    scopeIds,
    issues,
    recoveries: recoveries.filter(r => videos.some(v => v.id === r.id))
  };
}
async function appendVerdicts(root, entries) {
  if (!Array.isArray(entries) || !entries.length) return [];
  const p = path.join(root, 'chat_verdicts.json');
  const ledger = await loadLedger(root);
  const current = new Map(ledger.entries.map(entry => [String(entry.id), entry]));
  let changed = false;
  const results = entries.map(entry => {
    const id = String(entry.id), found = current.get(id);
    if (found) return { entry: found, added: false };
    ledger.history.push(entry); current.set(id, entry); changed = true;
    return { entry, added: true };
  });
  if (!changed) return results;
  // Keep an original backup before the first write to an existing ledger.
  await backupLedger(root, p);
  await atomicJson(p, ledger.encode(ledger.history));
  return results;
}
async function appendVerdict(root, entry) { return (await appendVerdicts(root, [entry]))[0]; }
async function supersedeVerdicts(root, ids, reason, metadata = {}) {
  const wanted = new Set([...ids].map(String));
  if (!wanted.size) return { changed: 0, ids: [] };
  if (typeof reason !== 'string' || !reason.trim()) throw new Error('A reason is required when superseding saved verdicts.');
  const p = path.join(root, 'chat_verdicts.json');
  const ledger = await loadLedger(root);
  const at = new Date().toISOString();
  const safeMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
  const changedIds = new Set();
  for (const entry of ledger.history) {
    if (entry?.superseded_at || !wanted.has(String(entry?.id))) continue;
    entry.superseded_at = at;
    entry.superseded_reason = reason.trim();
    if (safeMetadata.migration) entry.superseded_migration = String(safeMetadata.migration);
    changedIds.add(String(entry.id));
  }
  if (!changedIds.size) return { changed: 0, ids: [] };
  await backupLedger(root, p);
  await atomicJson(p, ledger.encode(ledger.history));
  return { changed: changedIds.size, ids: [...changedIds], at };
}
async function acquireLock(root, name = 'reelsight.lock') {
  if (!['reelsight.lock','prepare.lock'].includes(name)) throw new Error('Invalid lock name.');
  const p = path.join(root, 'logs', name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const h = await fs.open(p, 'wx');
      await h.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); await h.close();
      return async () => { await R.retryIO(() => fs.rm(p, { force: true })); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const old = await readJson(p, null);
      if (!Number.isInteger(old?.pid) || old.pid <= 0) throw new Error('Invalid project lock. Check that another review is not running before removing logs/reelsight.lock.');
      let alive = true;
      try { process.kill(old.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      if (alive) throw new Error('This project is already being reviewed by another Jewish Reels process.');
      await fs.rm(p, { force: true });
    }
  }
  throw new Error('Could not acquire the project lock.');
}
async function hashFile(p) {
  return R.retryIO(async () => {
  const h = crypto.createHash('sha256');
  const stream = require('node:fs').createReadStream(p);
  for await (const chunk of stream) h.update(chunk);
  return h.digest('hex');
  });
}
async function fingerprintVideo(video) {
  if (video.sharedFrom && video.sharedFingerprint) return video.sharedFingerprint;
  if (video.mp4 && await exists(video.mp4)) {
    const fingerprint = mediaFingerprint(await hashFile(video.mp4),video);
    if (video.expectedFingerprint && fingerprint !== video.expectedFingerprint) {
      const error = R.inputError('Source video differs from its prepared receipt. Re-prepare this video before reviewing it.');
      error.manual = true;
      error.recoveryKind = 'source_changed';
      throw error;
    }
    return fingerprint;
  }
  if (video.expectedFingerprint) {
    // Managed preparation may intentionally discard the bulky source after it
    // has published immutable cards.  The durable source fingerprint remains
    // trustworthy only while those exact published card bytes are still here.
    // Older receipts without a card signature keep the conservative behavior
    // and must be re-prepared from source before review.
    const expectedCards = video.prepared?.card_signature;
    if (video.prepared?.source_retired === true && typeof expectedCards === 'string' && expectedCards && await fingerprintCards(video) === expectedCards) return video.expectedFingerprint;
    if (video.prepared?.source_retired === true && expectedCards) {
      const error = R.inputError('Prepared cards differ from their verified receipt. Re-prepare this video before reviewing it.');
      error.manual = true;
      error.recoveryKind = 'source_changed';
      throw error;
    }
    throw R.inputError('Prepared source video is unavailable without a verified retirement receipt. Re-prepare this video before review.');
  }
  // Exact identical card files are safe to reuse; names and titles are not evidence.
  const hashes = [];
  for (const p of video.cards) hashes.push(await hashFile(p));
  return `cards-sha256:${sha(JSON.stringify(hashes))}`;
}
function mediaFingerprint(hash, source = {}) {
  const fingerprint = `mp4-sha256:${hash}`;
  if (source.scope !== 'segment') return fingerprint;
  const start=source.segment_start,end=source.segment_end;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start)throw new Error('Cannot identify a story without valid segment boundaries.');
  return `${fingerprint}:segment:${start}:${end}`;
}
async function fingerprintCards(video) {
  const hashes = [];
  for (const p of video.cards) hashes.push([path.basename(p), await hashFile(p)]);
  return sha(JSON.stringify(hashes));
}
module.exports = { natural, sha, exists, readJson, atomicJson, loadLedger, activeEntries, discover, appendVerdict, appendVerdicts, supersedeVerdicts, acquireLock, hashFile, fingerprintVideo, fingerprintCards, decodeLedger, mediaFingerprint };
