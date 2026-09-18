const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sha } = require('./storage.cjs');

function webUrl(value) {
  try { const u = new URL(String(value || '').trim()); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
}
function stableId(url) {
  const u = new URL(url);
  if (/(^|\.)filmhiradokonline\.hu$/i.test(u.hostname) && /^\d+$/.test(u.searchParams.get('id') || '')) return `fho-${u.searchParams.get('id')}`;
  if (/(^|\.)archiv-akh\.de$/i.test(u.hostname) && /\/filme\/\d+/.test(u.pathname)) return `akh-${u.pathname.match(/\/filme\/(\d+)/)[1]}`;
  if (/(^|\.)footagefarm\.com$/i.test(u.hostname) && /\/reel-details\/\d+\//.test(u.pathname)) return `ff-${u.pathname.match(/\/reel-details\/(\d+)\//)[1]}`;
  return `url-${sha(url).slice(0, 20)}`;
}
function sourceKey(value) {
  const base = path.basename(String(value || ''), path.extname(String(value || ''))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base || `source-${sha(String(value || '')).slice(0, 10)}`;
}
// Quoted CSV/TSV, including embedded newlines. Headerless Shtetl TSV is supported.
function parseDelimited(text, delimiter = ',') {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (c === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (quoted) throw new Error('Unclosed quote in URL list.');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
function sourceRows(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.db', '.sqlite', '.sqlite3'].includes(ext)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      if (tables.includes('pages')) return db.prepare('SELECT qid,wid,fields FROM pages ORDER BY CAST(wid AS INTEGER)').all().map(r => {
        let fields = {}; try { fields = JSON.parse(r.fields); } catch {}
        return { url: `https://filmhiradokonline.hu/watch.php?id=${r.wid}`, title: fields['inzertszöveg'] || '', catalog_id: r.qid };
      }).filter(r => /id=\d+$/.test(r.url));
      if (tables.includes('queue_items')) return db.prepare('SELECT id,url,title FROM queue_items ORDER BY id').all().map(r => ({ ...r, catalog_id: r.id }));
      throw new Error('Database has neither the Shtetl queue_items table nor Hungarian pages table.');
    } finally { db.close(); }
  }
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (ext === '.json') {
    const raw = JSON.parse(text), rows = Array.isArray(raw) ? raw : raw.videos || raw.urls || raw.items;
    if (!Array.isArray(rows)) throw new Error('JSON must contain an array of URLs or records with url fields.');
    return rows.map(r => typeof r === 'string' ? { url: r } : { url: r.url || r.watch_url || r.external_url, title: r.title || '', catalog_id: r.id });
  }
  if (ext === '.txt') return text.split(/\r?\n/).map(url => ({ url }));
  const rows = parseDelimited(text, ext === '.tsv' ? '\t' : ',');
  if (!rows.length) return [];
  const header = rows[0].map(v => v.trim().toLowerCase());
  const names = ['url', 'watch_url', 'source_url', 'external_url', 'stream_url', 'shown_at', 'detail_url'];
  const urlColumns = names.map(n => header.indexOf(n)).filter(n => n >= 0), titleCol = header.indexOf('title');
  if (urlColumns.length) return rows.slice(1).map(r => ({ url: urlColumns.map(i => webUrl(r[i])).find(Boolean), title: r[titleCol] || '' }));
  return rows.map(r => ({ url: r.map(webUrl).find(Boolean), title: r.length > 2 ? r[1] : '' }));
}
class QueueStore {
  constructor(root) {
    this.root = root; fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });
    this.db = new DatabaseSync(path.join(root, '.pipeline', 'queue.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,url TEXT UNIQUE NOT NULL,title TEXT NOT NULL DEFAULT '',source_file TEXT,catalog_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,media_url TEXT,media_key TEXT,source_hash TEXT,
        owner_id TEXT,duration REAL,frame_count INTEGER,card_count INTEGER,bytes INTEGER DEFAULT 0,error TEXT,updated_at TEXT);
      CREATE INDEX IF NOT EXISTS status_idx ON items(status); CREATE INDEX IF NOT EXISTS media_idx ON items(media_key);
      CREATE INDEX IF NOT EXISTS source_hash_idx ON items(source_hash);
      CREATE TABLE IF NOT EXISTS imports(file TEXT PRIMARY KEY,at TEXT,added INTEGER,source_key TEXT,label TEXT);
      CREATE TABLE IF NOT EXISTS item_sources(item_id TEXT NOT NULL,source_key TEXT NOT NULL,PRIMARY KEY(item_id,source_key));
      CREATE INDEX IF NOT EXISTS item_sources_source_idx ON item_sources(source_key,item_id);
      CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY,at TEXT NOT NULL,details TEXT);`);
    for (const [name,type] of [['source_key','TEXT'],['label','TEXT'],['kind','TEXT']]) if (!this.db.prepare('PRAGMA table_info(imports)').all().some(c=>c.name===name)) this.db.exec(`ALTER TABLE imports ADD COLUMN ${name} ${type}`);
    this.db.exec("UPDATE imports SET kind=CASE WHEN REPLACE(file,'\\','/') LIKE '%/.pipeline/sources/%' THEN 'crawled' ELSE 'imported' END WHERE kind IS NULL OR kind=''");
    for (const row of this.db.prepare("SELECT id,source_file FROM items WHERE id NOT IN (SELECT item_id FROM item_sources)").all()) this.db.prepare('INSERT OR IGNORE INTO item_sources VALUES(?,?)').run(row.id,sourceKey(row.source_file||'legacy'));
    this.activeSource = null;
  }
  import(file, options = {}) {
    const rows = sourceRows(file); let added = 0, invalid = 0, reconciled = 0;
    const key = options.sourceKey || sourceKey(file), label = options.label || path.basename(file), kind=options.kind==='crawled'?'crawled':'imported';
    const insert = this.db.prepare("INSERT INTO items(id,url,title,source_file,catalog_id,updated_at) VALUES(?,?,?,?,?,?)");
    const attach = this.db.prepare('INSERT OR IGNORE INTO item_sources(item_id,source_key) VALUES(?,?)');
    const byUrl = this.db.prepare('SELECT * FROM items WHERE url=?');
    const byId = this.db.prepare('SELECT * FROM items WHERE id=?');
    const metadata = this.db.prepare('UPDATE items SET title=?,source_file=?,catalog_id=?,updated_at=? WHERE id=? AND (title IS NOT ? OR source_file IS NOT ? OR catalog_id IS NOT ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Catalog refreshes are additive. A public site may reorganize themes or
      // omit older pages from today's index even though their canonical URLs
      // still work; removing those rows would throw away useful history. The
      // one exception is Footage Farm's numeric share shell, which returns an
      // empty 404-style page and was mistakenly imported by the old crawler.
      if (kind === 'crawled' && key === 'footagefarm') this.db.prepare(`DELETE FROM item_sources WHERE source_key=? AND item_id IN (
        SELECT id FROM items WHERE url LIKE 'https://footagefarm.com/reel-details/%' AND url GLOB 'https://footagefarm.com/reel-details/[0-9]*/[0-9]*'
      )`).run(key);
      for (const r of rows) {
        const url = webUrl(r.url); if (!url) { invalid++; continue; }
        const catalogId=String(r.catalog_id??''),title=String(r.title || ''),now=new Date().toISOString();
        const desiredId=key==='footagefarm'&&/^\d+$/.test(catalogId)?`ff-${catalogId}`:stableId(url);
        // URL is the durable source identity. Catalog IDs from a crawler can
        // be corrected later; binding by URL preserves previously reviewed or
        // prepared work instead of silently moving it to a different film.
        let item=byUrl.get(url);
        if (!item) {
          let id=desiredId;
          const occupied=byId.get(id);
          const numericShell=occupied && key==='footagefarm' && /^https?:\/\/(?:www\.)?footagefarm\.com\/reel-details\/\d+\/\d+\/?$/i.test(occupied.url);
          const emptyShell=numericShell && ['pending','unavailable','error'].includes(occupied.status)
            && !occupied.media_url && !occupied.media_key && !occupied.source_hash && !occupied.owner_id
            && !occupied.duration && !occupied.frame_count && !occupied.card_count && !occupied.bytes
            && !fs.existsSync(path.join(this.root,'frames',id)) && !fs.existsSync(path.join(this.root,'.pipeline','receipts',`${id}.json`));
          if (emptyShell) {
            this.db.prepare(`UPDATE items SET url=?,title=?,source_file=?,catalog_id=?,status='pending',attempts=0,
              media_url=NULL,media_key=NULL,source_hash=NULL,owner_id=NULL,duration=NULL,frame_count=NULL,card_count=NULL,bytes=0,error=NULL,updated_at=? WHERE id=?`)
              .run(url,title,file,catalogId,now,id);
            item=byId.get(id); reconciled++;
          } else {
            if (occupied) id=`${key==='footagefarm'?'ff':'url'}-url-${sha(url).slice(0,20)}`;
            insert.run(id,url,title,file,catalogId,now); item=byId.get(id); added++;
          }
        } else {
          reconciled += Number(metadata.run(title,file,catalogId,now,item.id,title,file,catalogId).changes);
          item=byId.get(item.id);
        }
        attach.run(item.id,key);
      }
      this.db.prepare('INSERT OR REPLACE INTO imports(file,at,added,source_key,label,kind) VALUES(?,?,?,?,?,?)').run(file, new Date().toISOString(), added,key,label,kind);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { added, reconciled, invalid, alreadyPresent: rows.length - added - invalid, total: this.counts().total, file, sourceKey:key, label };
  }
  setActiveSource(key) { if (key && !this.sourcesList().some(s=>s.key===key)) throw new Error('Choose an imported source.'); this.activeSource=key||null; return this.activeSource; }
  sourcesList() { return this.db.prepare("SELECT source_key key,COALESCE(MAX(NULLIF(label,'')),source_key) label,COALESCE(MAX(NULLIF(kind,'')),'imported') kind,MAX(at) imported_at,COUNT(DISTINCT item_id) total FROM imports JOIN item_sources USING(source_key) GROUP BY source_key ORDER BY label").all(); }
  scope(sql='') { return this.activeSource ? `${sql?' AND ':' WHERE '}EXISTS(SELECT 1 FROM item_sources s WHERE s.item_id=items.id AND s.source_key=?)` : ''; }
  args() { return this.activeSource ? [this.activeSource] : []; }
  get(id) { return this.db.prepare('SELECT * FROM items WHERE id=?').get(id); }
  update(id, changes) {
    const allowed = ['status','attempts','media_url','media_key','source_hash','owner_id','duration','frame_count','card_count','bytes','error'];
    const pairs = Object.entries(changes).filter(([k]) => allowed.includes(k));
    if (!pairs.length) return 0;
    const values = pairs.map(([, v]) => v ?? null);
    // SQLite is configured for fully durable writes. Rewriting an unchanged row
    // still flushes the WAL and used to make every verdict-maintenance pass pay
    // for hundreds of settled hits. Keep updated_at stable and avoid the write
    // entirely unless at least one requested value is different.
    const changed = pairs.map(([k]) => `${k} IS NOT ?`).join(' OR ');
    return Number(this.db.prepare(`UPDATE items SET ${pairs.map(([k]) => `${k}=?`).join(',')},updated_at=? WHERE id=? AND (${changed})`)
      .run(...values, new Date().toISOString(), id, ...values).changes);
  }
  next() { return this.db.prepare(`SELECT * FROM items WHERE status='pending'${this.scope('x')} ORDER BY rowid LIMIT 1`).get(...this.args()); }
  shared(key, id) { return this.db.prepare(`SELECT * FROM items WHERE media_key=? AND id<>? AND owner_id=id AND status IN ('ready','hit','no','filtered_no','cleaned')${this.scope('x')} ORDER BY rowid LIMIT 1`).get(key, id,...this.args()); }
  sameContent(hash, id) { return this.db.prepare(`SELECT * FROM items WHERE source_hash=? AND id<>? AND owner_id=id AND status IN ('ready','hit','no','filtered_no','cleaned')${this.scope('x')} ORDER BY rowid`).all(hash, id,...this.args()); }
  sources(url, id) { return this.db.prepare(`SELECT id,owner_id,source_hash FROM items WHERE media_url=? AND id<>? AND source_hash IS NOT NULL${this.scope('x')} ORDER BY rowid`).all(url,id,...this.args()); }
  counts() { const out = { total: 0 }; for (const r of this.db.prepare(`SELECT status,count(*) n FROM items${this.scope()} GROUP BY status`).all(...this.args())) { out[r.status] = Number(r.n); out.total += Number(r.n); } return out; }
  recent() { return this.db.prepare(`SELECT id,title,status,error,duration,frame_count,card_count,owner_id FROM items WHERE status<>'pending'${this.scope('x')} ORDER BY updated_at DESC LIMIT 40`).all(...this.args()); }
  all(status) { return this.db.prepare(`SELECT * FROM items WHERE status=?${this.scope('x')}`).all(status,...this.args()); }
  rows() { return this.db.prepare('SELECT * FROM items ORDER BY rowid').all(); }
  migration(name) { return this.db.prepare('SELECT * FROM migrations WHERE name=?').get(name) || null; }
  recordMigration(name, details = {}) { this.db.prepare('INSERT OR REPLACE INTO migrations(name,at,details) VALUES(?,?,?)').run(name,new Date().toISOString(),JSON.stringify(details)); }
  requeueFootageFarmUnavailable(name = 'footagefarm-vimeo-resolver-v1') {
    if(this.migration(name))return 0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=Number(this.db.prepare(`UPDATE items SET status='pending',attempts=0,error=NULL,updated_at=?
        WHERE url LIKE 'https://footagefarm.com/reel-details/%' AND status='unavailable' AND error LIKE 'PREVIEW_UNAVAILABLE:%'`).run(new Date().toISOString()).changes);
      this.db.prepare('INSERT INTO migrations(name,at,details) VALUES(?,?,?)').run(name,new Date().toISOString(),JSON.stringify({requeued:changed}));
      this.db.exec('COMMIT');return changed;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  retryVimeoAuthenticationRequired() {
    return Number(this.db.prepare(`UPDATE items SET status='pending',error=NULL,updated_at=? WHERE status='error'
      AND error LIKE 'Vimeo access is required for this Footage Farm screener.%'`).run(new Date().toISOString()).changes);
  }
  resetMediaRows(ids) {
    const values=[...new Set(ids.map(String))];if(!values.length)return 0;
    let changed=0;this.db.exec('BEGIN IMMEDIATE');
    try {
      for(let offset=0;offset<values.length;offset+=400){
        const part=values.slice(offset,offset+400),slots=part.map(()=>'?').join(',');
        changed+=Number(this.db.prepare(`UPDATE items SET status='pending',attempts=0,media_url=NULL,media_key=NULL,source_hash=NULL,
          owner_id=NULL,duration=NULL,frame_count=NULL,card_count=NULL,bytes=0,error=NULL,updated_at=? WHERE id IN (${slots})`)
          .run(new Date().toISOString(),...part).changes);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    return changed;
  }
  readyReels() { return this.db.prepare(`SELECT id,source_hash,media_key,card_count,frame_count FROM items WHERE status='ready' AND owner_id=id${this.scope('x')}`).all(...this.args()); }
  recover() { this.db.exec("UPDATE items SET status='pending' WHERE status IN ('resolving','downloading','extracting','screening')"); }
  retryCorrectedGeometryFailures() {
    return Number(this.db.prepare("UPDATE items SET status='pending',error=NULL,updated_at=? WHERE status='error' AND error LIKE ?")
      .run(new Date().toISOString(), '%Padded dimensions cannot be smaller than input dimensions%').changes)
      + Number(this.db.prepare("UPDATE items SET status='pending',error=NULL,updated_at=? WHERE status='error' AND error LIKE 'Coverage check failed:%'")
      .run(new Date().toISOString()).changes);
  }
  classifyPreviewUnavailable() { return Number(this.db.prepare("UPDATE items SET status='unavailable',updated_at=? WHERE status='error' AND error LIKE 'PREVIEW_UNAVAILABLE:%'").run(new Date().toISOString()).changes); }
  retryLegacyFootageFarmFailures() {
    // These errors were produced by the old Vimeo fallback or by one-shot
    // source downloads before Footage Farm gained its direct, retrying MP4
    // resolver. Legacy signatures get at most three total attempts. A generic
    // page-fetch outage can receive up to twelve bounded attempts because it is
    // normally DNS/socket availability rather than a bad catalog record. Both
    // caps keep persistent failures visible instead of hot-looping on restart.
    return Number(this.db.prepare(`UPDATE items SET status='pending',error=NULL,updated_at=?
      WHERE status='error' AND id LIKE 'ff-%' AND (
        attempts<12 AND error='fetch failed'
        OR attempts<3 AND (
        error LIKE '%Unsupported URL:%footagefarm.com%'
        OR error LIKE '%[vimeo]%' AND error LIKE '%401%Unauthorized%'
        OR error='terminated'
        OR error='An existing folder is not owned by this preparation queue. It has been preserved.'
        OR error LIKE 'yt-dlp.exe failed (%' AND (
          error LIKE '%getaddrinfo failed%'
          OR error LIKE '%Could not connect to server%'
          OR error LIKE '%Connection closed abruptly%'
          OR error LIKE '%HTTP Error 404: Not Found%'
        )
        OR error LIKE 'ffmpeg.exe failed (%' AND (
          error LIKE '%Invalid NAL unit size%'
          OR error LIKE '%Error splitting the input into NAL units%'
          OR error LIKE '%Invalid data found when processing input%'
        )
        )
      )`).run(new Date().toISOString()).changes);
  }
  retry() { this.db.prepare(`UPDATE items SET status='pending',error=NULL WHERE status='error'${this.scope('x')}`).run(...this.args()); }
  close() { this.db.close(); }
}
async function detectSources(documents) {
  const base = path.join(documents, 'hasidic-footage-scan', 'output');
  const choices = [['Hungarian newsreel catalog', 'fho_pages.db'], ['Shtetl download queue', 'shtetlframes.db'], ['European Film Gateway discovery', 'efg_discovery_pre1950.csv'], ['Cross-archive catalog URLs', 'jewish_catalog_hits.csv']];
  const found = [];
  for (const [label, name] of choices) { const file = path.join(base, name); try { await fsp.access(file); found.push({ label, file }); } catch {} }
  return found;
}
module.exports = { QueueStore, sourceRows, parseDelimited, stableId, webUrl, detectSources, sourceKey };
