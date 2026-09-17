const fs = require('node:fs/promises');
const path = require('node:path');

const BASE = 'https://footagefarm.com';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function links(html, pattern) {
  const out = new Set();
  for (const match of String(html).matchAll(/(?:href|data-url)=["']([^"']+)["']/gi)) {
    let value = match[1].replace(/\\\//g, '/').replace(/&amp;/g, '&');
    try { value = new URL(value, BASE).href; } catch { continue; }
    if (pattern.test(new URL(value).pathname)) out.add(value.replace(/\/$/, ''));
  }
  return [...out];
}
async function fetchPage(url, { fetchImpl = fetch, retries = 4 } = {}) {
  let error;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'JewishReels/2.4 (+public catalog importer)', accept: 'text/html' }, redirect: 'follow' });
      if (!response.ok) throw new Error(`Footage Farm returned HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (e) {
      error = e;
      if (attempt < retries) await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw error;
}
async function mapLimit(values, limit, fn) {
  const result = new Array(values.length); let cursor = 0;
  async function worker() { while (true) { const i = cursor++; if (i >= values.length) return; result[i] = await fn(values[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return result;
}
function reelRows(html, sourcePage) {
  const rows=new Map(),text=String(html),numeric=/(?:data-url|href)=["'](https?:\\?\/\\?\/footagefarm\.com\\?\/reel-details\\?\/(\d+)\\?\/\d+)["']/gi;
  for(const match of text.matchAll(numeric)){
    const id=match[2],before=text.slice(Math.max(0,match.index-9000),match.index),pretty=[...before.matchAll(/href=["'](https?:\\?\/\\?\/footagefarm\.com\\?\/reel-details\\?\/[^"']+)["']/gi)].map(x=>x[1].replace(/\\\//g,'/')).filter(url=>/^https:\/\/footagefarm\.com\/reel-details\/[^/]+\/[^/]+\/[^/]+\/?$/.test(url)).at(-1);
    const share=match[1].replace(/\\\//g,'/'),url=pretty||share,slug=pretty?decodeURIComponent(new URL(pretty).pathname.split('/').pop()).replace(/-+/g,' ').trim():`Footage Farm reel ${id}`;
    if(!rows.has(id))rows.set(id,{id,url,title:slug,source_page:sourcePage,share_url:share});
  }
  return [...rows.values()];
}
async function themeUrls(fetchImpl = fetch) {
  const response = await fetchImpl(`${BASE}/theme`, { headers: { 'user-agent': 'JewishReels/2.4 (+public catalog importer)', accept: 'text/html' } });
  if (!response.ok) throw new Error(`Footage Farm returned HTTP ${response.status} for its theme catalog.`);
  const html = await response.text(), token = html.match(/name=["'](csrf[^"']*)["'][^>]*value=["']([a-f0-9]+)["']/i);
  if (!token) throw new Error('Footage Farm did not provide its public catalog token.');
  const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const body = new URLSearchParams({ [token[1]]: token[2] });
  const data = await fetchImpl(`${BASE}/theme/themedata`, { method: 'POST', headers: { 'user-agent': 'JewishReels/2.4 (+public catalog importer)', accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'XMLHttpRequest', cookie: cookies.map(v=>v.split(';')[0]).join('; ') }, body });
  if (!data.ok) throw new Error(`Footage Farm returned HTTP ${data.status} for its theme index.`);
  const json = await data.json();
  return links(json.data, /^\/subtheme\/[^/]+\/?$/).filter(url=>!/\/\d+$/.test(new URL(url).pathname));
}
async function crawl({ output, concurrency = 6, fetchImpl = fetch, onProgress = () => {} } = {}) {
  if (!output) throw new Error('Choose where to save the Footage Farm catalog.');
  const root = path.resolve(output), checkpoint = root + '.checkpoint.json';
  await fs.mkdir(path.dirname(root), { recursive: true });
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(checkpoint, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const themes = await themeUrls(fetchImpl);
  if (!themes.length) throw new Error('Footage Farm returned no public theme URLs. Its catalog layout may have changed.');
  const subthemes = new Set(saved.subthemes || []), reels = new Map((saved.reels || []).map(r => [String(r.id || r.url), r]));
  await mapLimit(themes, concurrency, async (url, index) => {
    for (const value of links(await fetchPage(url, { fetchImpl }), /^\/subthemes\/[^/]+\/[^/]+\/?$/)) subthemes.add(value);
    onProgress({ stage: 'themes', completed: index + 1, total: themes.length, subthemes: subthemes.size, reels: reels.size });
  });
  const subthemeUrls = [...subthemes].sort(); let completed = 0;
  await mapLimit(subthemeUrls, concurrency, async url => {
    const html = await fetchPage(url, { fetchImpl });
    for(const row of reelRows(html,url))if(!reels.has(row.id))reels.set(row.id,row);
    completed++;
    if (completed % 10 === 0) await fs.writeFile(checkpoint, JSON.stringify({ version: 1, subthemes: subthemeUrls, reels: [...reels.values()] }) + '\n');
    onProgress({ stage: 'subthemes', completed, total: subthemeUrls.length, subthemes: subthemeUrls.length, reels: reels.size });
  });
  const byUrl=new Map();for(const row of reels.values()){const existing=byUrl.get(row.url);if(existing){existing.alias_ids??=[];existing.alias_ids.push(row.id);}else byUrl.set(row.url,{...row});}
  const items = [...byUrl.values()].sort((a, b) => Number(a.id)-Number(b.id));
  const document = { version: 1, source: { key: 'footagefarm', label: 'Footage Farm', homepage: BASE, crawled_at: new Date().toISOString() }, total: items.length, items };
  await fs.writeFile(root, JSON.stringify(document, null, 2) + '\n');
  await fs.rm(checkpoint, { force: true });
  return { file: root, total: items.length, themes: themes.length, subthemes: subthemeUrls.length };
}

module.exports = { BASE, links, reelRows, fetchPage, mapLimit, themeUrls, crawl };
