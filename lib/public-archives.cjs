const fs = require('node:fs/promises');
const path = require('node:path');

const PRELINGER_HOME = 'https://archive.org/details/prelinger';
const LOC_HOME = 'https://www.loc.gov/collections/national-screening-room/';
const UA = 'JewishReels/2.5 (+public archive catalog importer)';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url, fetchImpl = fetch, signal, retries = 3) {
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const response = await fetchImpl(url, {
        headers: { 'user-agent': UA, accept: 'application/json' }, signal: requestSignal
      });
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      return await response.json();
    } catch (error) {
      last = error;
      if (signal?.aborted || error.status && error.status < 500 && error.status !== 429) throw error;
      if (attempt < retries) await sleep(300 * 2 ** attempt);
    }
  }
  throw last;
}

function safeIdentifier(value) {
  const id = String(value || '').trim();
  return id && id.length <= 300 && !/[\s/?#\\]/.test(id) ? id : null;
}

async function writeCatalog(output, source, items) {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ version: 1, source, total: items.length, items }, null, 2) + '\n');
}

async function crawlPrelinger({ output, fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const items = new Map(), cursors = new Set(); let cursor = '', pages = 0, total = 0;
  do {
    const endpoint = new URL('https://archive.org/services/search/v1/scrape');
    endpoint.searchParams.set('q', 'collection:prelinger AND mediatype:movies');
    endpoint.searchParams.set('fields', 'identifier,title,year,date');
    endpoint.searchParams.set('count', '500');
    if (cursor) endpoint.searchParams.set('cursor', cursor);
    const data = await json(endpoint, fetchImpl, signal);
    total = Number(data.total || total || 0);
    for (const row of Array.isArray(data.items) ? data.items : []) {
      const id = safeIdentifier(row.identifier); if (!id) continue;
      items.set(id, { url: `https://archive.org/details/${encodeURIComponent(id)}`, title: String(row.title || id), catalog_id: id });
    }
    pages++;
    onProgress({ stage: 'catalog', completed: pages, total: total ? Math.ceil(total / 500) : pages, reels: items.size });
    const next = String(data.cursor || '');
    if (!next || !(Array.isArray(data.items) && data.items.length) || cursors.has(next)) break;
    cursors.add(next); cursor = next;
  } while (true);
  const rows = [...items.values()].sort((a, b) => String(a.catalog_id).localeCompare(String(b.catalog_id)));
  await writeCatalog(output, { key: 'prelinger', label: 'Prelinger Archives', homepage: PRELINGER_HOME, crawled_at: new Date().toISOString() }, rows);
  return { file: output, total: rows.length, pages, sourceKey: 'prelinger', label: 'Prelinger Archives' };
}

function locVideos(record) {
  const found = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.video === 'string') {
      try {
        const url = new URL(value.video);
        if (url.protocol === 'https:' && /(?:^|\.)loc\.gov$/i.test(url.hostname) && /\.mp4(?:$|\?)/i.test(url.href)) found.push(url.href);
      } catch {}
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(record.resources);
  return [...new Set(found)];
}

async function crawlLoc({ output, fetchImpl = fetch, signal, onProgress = () => {} } = {}) {
  const items = new Map(); let pages = 0, declaredTotal = 0, skipped = 0;
  const consume = data => {
    for (const record of Array.isArray(data.results) ? data.results : []) {
      const match = String(record.url || record.id || '').match(/^https:\/\/www\.loc\.gov\/item\/([^/?#]+)\/?$/i);
      const id = safeIdentifier(match?.[1]); if (!id) continue;
      const videos = locVideos(record);
      videos.forEach((video, index) => {
        const key = `${id}:${index}`;
        items.set(key, { url: `https://www.loc.gov/item/${encodeURIComponent(id)}/?resource=${index}`, title: String(record.title || id) + (videos.length > 1 ? ` · part ${index + 1}` : ''), catalog_id: key });
      });
    }
    pages++;
    onProgress({ stage: 'catalog', completed: Math.min(declaredTotal, items.size + skipped), total: declaredTotal, reels: items.size });
  };
  const request = async (offset, count) => {
    const endpoint = new URL(LOC_HOME); endpoint.searchParams.set('fo', 'json'); endpoint.searchParams.set('c', String(count)); endpoint.searchParams.set('sp', String(Math.floor(offset / count) + 1));
    return json(endpoint, fetchImpl, signal, 1);
  };
  const first = await request(0, 100);
  declaredTotal = Number(first.pagination?.of || 0);
  if (!Number.isInteger(declaredTotal) || declaredTotal < 0) throw new Error('Library of Congress catalog did not report a valid result count.');
  consume(first);
  // A single malformed LOC record can make one large result page return 404.
  // Split only that range into smaller aligned pages so the surrounding films
  // remain available; at worst one irretrievable record is reported skipped.
  const widths = [100, 50, 25, 5, 1];
  const readRange = async (offset, count) => {
    try { consume(await request(offset, count)); return; }
    catch (error) {
      if (signal?.aborted) throw error;
      const width = widths.find(value => value < count && count % value === 0);
      if (!width) { skipped++; return; }
      for (let start = offset; start < Math.min(offset + count, declaredTotal); start += width) await readRange(start, width);
    }
  };
  for (let offset = 100; offset < declaredTotal; offset += 100) await readRange(offset, 100);
  const rows = [...items.values()].sort((a, b) => String(a.catalog_id).localeCompare(String(b.catalog_id)));
  await writeCatalog(output, { key: 'loc-national-screening-room', label: 'Library of Congress · National Screening Room', homepage: LOC_HOME, crawled_at: new Date().toISOString() }, rows);
  return { file: output, total: rows.length, pages, catalogTotal: declaredTotal, skipped, sourceKey: 'loc-national-screening-room', label: 'Library of Congress · National Screening Room' };
}

function prelingerId(url) {
  try {
    const parsed = new URL(url), match = parsed.pathname.match(/^\/details\/([^/]+)\/?$/);
    if (parsed.protocol !== 'https:' || !/(?:^|\.)archive\.org$/i.test(parsed.hostname) || !match) return null;
    return safeIdentifier(decodeURIComponent(match[1]));
  } catch { return null; }
}

function locItem(url) {
  try {
    const parsed = new URL(url), match = parsed.pathname.match(/^\/item\/([^/]+)\/?$/);
    if (parsed.protocol !== 'https:' || !/(?:^|\.)loc\.gov$/i.test(parsed.hostname) || !match) return null;
    const id = safeIdentifier(decodeURIComponent(match[1])), resource = Number(parsed.searchParams.get('resource') || 0);
    return id && Number.isInteger(resource) && resource >= 0 && resource < 1000 ? { id, resource } : null;
  } catch { return null; }
}

function archiveMp4s(metadata, id) {
  const rows = [];
  for (const file of Array.isArray(metadata?.files) ? metadata.files : []) {
    const name = String(file?.name || '');
    if (!/\.mp4$/i.test(name) || /(?:^|[._-])(?:sample|thumb|trailer)(?:[._-]|$)/i.test(name)) continue;
    const size = Number(file.size || 0), format = String(file.format || '');
    let score = 0;
    if (/512\s*kb.*mpeg4/i.test(format + ' ' + name)) score += 100;
    if (/h\.264|mpeg4/i.test(format)) score += 60;
    if (file.source === 'derivative') score += 20;
    if (size > 1_000_000 && size < 2_000_000_000) score += 10;
    rows.push({ provider: 'prelinger', url: `https://archive.org/download/${encodeURIComponent(id)}/${encodeURIComponent(name)}`, referer: `https://archive.org/details/${encodeURIComponent(id)}`, direct: true, scope: 'whole-reel', score, size });
  }
  return rows.sort((a, b) => b.score - a.score || a.size - b.size || a.url.localeCompare(b.url));
}

module.exports = { PRELINGER_HOME, LOC_HOME, crawlPrelinger, crawlLoc, locVideos, prelingerId, locItem, archiveMp4s };
