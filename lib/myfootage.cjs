const fs = require('node:fs/promises');
const path = require('node:path');

const BASE = 'https://www.myfootage.com/';
const UA = 'JewishReels/2.5 (user-selected archival clip importer)';
const DEFAULT_DECADES = Object.freeze([
  '1880s', '1890s', '1900s', '1910s', '1920s',
  '1930s', '1940s', '1950s', '1960s', '1970s',
  '1980s', '1990s', '2000s', '2010s', '2020s'
]);

function asUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch { return null; }
}

function isMyFootageUrl(value) {
  const url = asUrl(value);
  return !!url && url.protocol === 'https:' && !url.port && /^(?:www\.)?myfootage\.com$/i.test(url.hostname);
}

function itemIdFromUrl(value) {
  const url = asUrl(value);
  if (!url || !isMyFootageUrl(url.href)) return null;
  const queryId = url.searchParams.get('item');
  if (/^\d+$/.test(queryId || '')) return queryId;
  const friendly = url.pathname.match(/^\/(\d+)(?:[-.]|$)/);
  if (friendly) return friendly[1];
  const media = url.pathname.match(/^\/pix\/\d+\/(\d+)(?:[-_.]|$)/i);
  return media?.[1] || null;
}

function isClipUrl(value) {
  const url = asUrl(value), id = itemIdFromUrl(value);
  if (!url || !id) return false;
  return /^\/preview\.asp$/i.test(url.pathname)
    || /^\/\d+(?:[-.][^/]*)?\.html$/i.test(url.pathname)
    || /^\/pix\/\d+\/\d+[^/]*\.(?:mp4|mov|m4v|webm)$/i.test(url.pathname);
}

function canonicalItemUrl(value) {
  const id = itemIdFromUrl(value);
  return id ? `${BASE}preview.asp?item=${id}` : null;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ');
}

function assignedJson(html, variable) {
  const text = String(html || '');
  const pattern = new RegExp(`\\b(?:var|let|const)\\s+${variable.replace(/[^a-z0-9_$]/gi, '')}\\s*=`, 'i');
  const match = pattern.exec(text);
  if (!match) return null;
  let start = match.index + match[0].length;
  while (/\s/.test(text[start] || '')) start++;
  const opening = text[start], closing = opening === '{' ? '}' : opening === '[' ? ']' : null;
  if (!closing) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === opening) depth++;
    else if (char === closing && --depth === 0) {
      try { return JSON.parse(text.slice(start, index + 1)); }
      catch { return null; }
    }
  }
  return null;
}

function safeMediaUrl(value, pageUrl, expectedId) {
  try {
    const url = new URL(decodeHtml(value), pageUrl || BASE);
    if (!isMyFootageUrl(url.href) || url.search || !/^\/pix\/\d+\/\d+[^/]*\.(?:mp4|mov|m4v|webm)$/i.test(url.pathname)) return null;
    const id = itemIdFromUrl(url.href);
    if (expectedId && id !== String(expectedId)) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function titleFromSlug(value) {
  const url = asUrl(value);
  const name = url?.pathname.split('/').at(-1)?.replace(/\.(?:html|mp4|mov|m4v|webm)$/i, '') || '';
  let decoded=name;try{decoded=decodeURIComponent(name);}catch{}
  return decoded.replace(/^\d+-?/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseResultsPage(html, pageUrl = `${BASE}results.asp`) {
  const source=new URL(pageUrl);
  if(!isMyFootageUrl(source.href)||!/^\/results\.asp$/i.test(source.pathname))throw new Error('MyFootage results must come from an HTTPS results.asp page.');
  const tallies = assignedJson(html, 'ResultsTallies') || {};
  const rawItems = assignedJson(html, 'ResultsItems');
  if (!Array.isArray(rawItems)) throw new Error('MyFootage results did not contain a readable ResultsItems catalog.');
  const items = [];
  for (const raw of rawItems) {
    const id = String(raw?.ItemID || '');
    if (!/^\d+$/.test(id) || String(raw?.MediaType || 'Video').toLowerCase() !== 'video') continue;
    const mediaUrl = safeMediaUrl(raw.PRPath, pageUrl, id);
    if (!mediaUrl) continue;
    items.push({
      id,
      catalog_id: id,
      url: canonicalItemUrl(`${BASE}preview.asp?item=${id}`),
      title: decodeHtml(raw.Caption).replace(/\s+/g, ' ').trim(),
      media_url: mediaUrl,
      thumbnail_url: raw.TNPath ? new URL(raw.TNPath, pageUrl).href : null,
      source_page: pageUrl
    });
  }
  return { tallies, items };
}

function parseClipPage(html, pageUrl) {
  const text = String(html || ''), item = assignedJson(text, 'Item') || {}, meta = assignedJson(text, 'Meta') || {};
  if(item.ItemFound===false)throw new Error('PREVIEW_UNAVAILABLE: MyFootage reports that this clip does not exist.');
  const identities=[item.ItemID,meta.MetaItemId,text.match(/<meta\b[^>]*\bproperty=["']og:item_id["'][^>]*\bcontent=["'](\d+)["']/i)?.[1],itemIdFromUrl(pageUrl)].map(value=>String(value||'')).filter(value=>/^\d+$/.test(value));
  const uniqueIds=[...new Set(identities)];
  if(!uniqueIds.length)throw new Error('MyFootage clip page did not identify a numeric item.');
  if(uniqueIds.length!==1)throw new Error('MyFootage clip identity does not match the requested item.');
  const id=uniqueIds[0];
  const candidates = [
    item.ImgPreview,
    meta.PreviewPath,
    ...[...text.matchAll(/<meta\b[^>]*\bproperty=["']og:video(?::(?:url|secure_url))?["'][^>]*\bcontent=["']([^"']+)["']/gi)].map(match => match[1]),
    ...[...text.matchAll(/<source\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1])
  ];
  const mediaUrl = candidates.map(value => safeMediaUrl(value, pageUrl, id)).find(Boolean);
  if (!mediaUrl) throw new Error('PREVIEW_UNAVAILABLE: This MyFootage clip page has no public watermarked video preview.');
  const ogTitle = text.match(/<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']+)["']/i)?.[1];
  const htmlTitle = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = decodeHtml(item.ImgCaption || ogTitle || htmlTitle || titleFromSlug(mediaUrl)).replace(/\s*(?:\||-)\s*MyFootage\s*$/i, '').replace(/\s+/g, ' ').trim();
  return { id, catalog_id: id, url: `${BASE}preview.asp?item=${id}`, title, media_url: mediaUrl, source_page: pageUrl };
}

function mediaHint(item) {
  const mediaUrl=safeMediaUrl(item?.media_url,item?.url||BASE,item?.id||item?.catalog_id);
  return mediaUrl ? { provider:'myfootage',url:mediaUrl,referer:item.url||item.source_page||BASE,direct:true,scope:'whole-reel' } : null;
}

function setCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers?.get?.('set-cookie');
  return combined ? combined.split(/,(?=\s*[^\s;,=]+=[^;,]*)/) : [];
}

function createCookieJar() {
  const cookies = new Map();
  return {
    header() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
    absorb(headers) {
      for (const value of setCookieHeaders(headers)) {
        const pair = String(value || '').split(';', 1)[0], equals = pair.indexOf('=');
        if (equals < 1) continue;
        const name = pair.slice(0, equals).trim(), cookieValue = pair.slice(equals + 1).trim();
        if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name)) continue;
        if (/;\s*max-age\s*=\s*0(?:\D|$)/i.test(value)) cookies.delete(name);
        else cookies.set(name, cookieValue);
      }
    }
  };
}

async function fetchText(url, fetchImpl = fetch, signal, cookieJar = null) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const cookie = cookieJar?.header();
      const response = await fetchImpl(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', ...(cookie ? { Cookie: cookie } : {}) },
        signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)])
      });
      cookieJar?.absorb(response.headers);
      if (!response.ok) throw new Error(`MyFootage returned HTTP ${response.status}.`);
      return await response.text();
    } catch (error) {
      last = error;
      if (signal?.aborted || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 400 * 2 ** attempt));
    }
  }
  throw last;
}

async function importSelectedClip({ startUrl, output, fetchImpl = fetch, signal, onProgress = () => {} }) {
  if (!isMyFootageUrl(startUrl)) throw new Error('Choose a URL on myfootage.com.');
  if (!isClipUrl(startUrl)) {
    const error = new Error('MyFootage does not permit automated catalog crawling. Paste an individual MyFootage clip page URL, or import an authorized TXT, CSV, or JSON list of clip URLs.');
    error.code = 'MYFOOTAGE_MANUAL_ONLY';
    throw error;
  }
  const id = itemIdFromUrl(startUrl), canonical = canonicalItemUrl(startUrl);
  onProgress({ stage: 'pages', completed: 0, total: 1, reels: 0 });
  let item;
  if (/^\/pix\//i.test(new URL(startUrl).pathname)) {
    item = { id, catalog_id: id, url: canonical, title: titleFromSlug(startUrl), media_url: new URL(startUrl).href, source_page: canonical };
  } else {
    item = parseClipPage(await fetchText(startUrl, fetchImpl, signal), startUrl);
  }
  const payload = {
    version: 1,
    source: { key: 'myfootage', label: 'MyFootage', homepage: BASE, imported_from: startUrl, mode: 'selected-clips', imported_at: new Date().toISOString() },
    total: 1,
    items: [item]
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(payload, null, 2) + '\n');
  onProgress({ stage: 'pages', completed: 1, total: 1, reels: 1 });
  return { file: output, total: 1, pages: 1, sourceKey: 'myfootage', label: 'MyFootage' };
}

function normalizeCatalogSeed(value, pageUrl = BASE) {
  try {
    const url = new URL(decodeHtml(value), pageUrl);
    if (!isMyFootageUrl(url.href) || !/^\/results\.asp$/i.test(url.pathname)) return null;
    const decades = url.searchParams.getAll('x0');
    if (decades.length !== 1 || [...url.searchParams.keys()].some(key => key !== 'x0')) return null;
    const decade = decades[0];
    if (!/^(?:18|19|20)\d0s$/i.test(decade)) return null;
    return `${BASE}results.asp?x0=${decade}`;
  } catch { return null; }
}

function defaultCatalogSeeds() {
  return DEFAULT_DECADES.map(decade => `${BASE}results.asp?x0=${decade}`);
}

function catalogSeeds(html, pageUrl = BASE) {
  const text = String(html || ''), all = [];

  // MyFootage's decade cards are Vue-bound. Their destinations live in the
  // server-rendered `aValue` array rather than ordinary href attributes.
  const pageValues = assignedJson(text, 'aValue');
  if (Array.isArray(pageValues)) {
    const pageTitles = assignedJson(text, 'aTitle');
    for (let index = 0; index < pageValues.length; index++) {
      const seed = normalizeCatalogSeed(pageValues[index], pageUrl);
      if (!seed) continue;
      const decade = new URL(seed).searchParams.get('x0');
      if (Array.isArray(pageTitles) && pageTitles.length === pageValues.length && String(pageTitles[index]) !== decade) continue;
      all.push(seed);
    }
  } else {
    // Secondary compatibility paths for a conventional server-rendered page.
    // The leading delimiter deliberately excludes Vue's `:href` binding.
    for (const match of text.matchAll(/(?:^|[\s<])href\s*=\s*["']([^"'#]+)["']/gi)) all.push(match[1]);
    for (const match of text.matchAll(/["']((?:https:\/\/(?:www\.)?myfootage\.com\/|\/)?results\.asp\?[^"']+)["']/gi)) all.push(match[1]);
  }

  const unique = [...new Set(all.map(value => normalizeCatalogSeed(value, pageUrl)).filter(Boolean))];
  return unique;
}

function resultsPageUrl(seed, tallies, pageNumber) {
  if (pageNumber === 1) return seed;
  const pageSize = Number(tallies?.PixPerPage), requestW = String(tallies?.RequestW || ''), requestF = String(tallies?.RequestF || '');
  if (!Number.isInteger(pageSize) || pageSize < 1 || !requestW || !requestF) throw new Error('MyFootage did not provide stable pagination fields for this search.');
  const expectedStep = String((pageNumber - 1) * pageSize + 1);
  const declared = String(tallies?.NextSearchURL || '').trim();
  const url = new URL('results.asp', BASE);
  if (declared) url.search = declared.startsWith('?') ? declared : `?${declared}`;
  if (!isMyFootageUrl(url.href) || !/^\/results\.asp$/i.test(url.pathname)) throw new Error('MyFootage supplied an unsafe next-page URL.');
  if (declared) {
    const allowed = new Set(['W', 'F', 'Step']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key))
      || url.searchParams.getAll('W').length !== 1
      || url.searchParams.getAll('F').length !== 1
      || url.searchParams.getAll('Step').length !== 1
      || url.searchParams.get('W') !== requestW
      || url.searchParams.get('F') !== requestF
      || url.searchParams.get('Step') !== expectedStep) {
      throw new Error('MyFootage supplied inconsistent next-page fields.');
    }
  } else {
    url.searchParams.set('W', requestW);
    url.searchParams.set('F', requestF);
    url.searchParams.set('Step', expectedStep);
  }
  // Continuation requests intentionally omit x0: MyFootage stores the active
  // search in its short-lived session and its own UI follows NextSearchURL.
  return url.href;
}

async function writeCatalog(output, startUrl, rows, authorizedAt) {
  const payload = {
    version: 1,
    source: { key: 'myfootage', label: 'MyFootage', homepage: BASE, imported_from: startUrl, mode: 'authorized-catalog', authorized_at: authorizedAt, crawled_at: new Date().toISOString() },
    total: rows.length,
    items: rows
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(payload, null, 2) + '\n');
}

async function crawlAuthorizedCatalog({ startUrl, output, authorized = false, fetchImpl = fetch, signal, onProgress = () => {}, delayMs = 500 }) {
  if (!authorized) {
    const error = new Error('MyFootage crawling is locked. Confirm that you have permission to crawl this source before starting.');
    error.code = 'SOURCE_PERMISSION_REQUIRED';
    throw error;
  }
  if (!isMyFootageUrl(startUrl)) throw new Error('Choose a URL on myfootage.com.');
  if (isClipUrl(startUrl)) return importSelectedClip({ startUrl, output, fetchImpl, signal, onProgress });
  const start = new URL(startUrl), authorizedAt = new Date().toISOString(), rows = new Map();
  let seeds;
  if (/^\/results\.asp$/i.test(start.pathname)) seeds = [start.href];
  else if (/^\/(?:index\.asp)?$/i.test(start.pathname)) {
    const home = await fetchText(start.href, fetchImpl, signal, createCookieJar());
    seeds = catalogSeeds(home, start.href);
    // The official home page has historically exposed these searches through
    // Vue page data. If that presentation layer changes, use the same stable
    // decade result endpoints rather than declaring the catalog unavailable.
    if (!seeds.length) seeds = defaultCatalogSeeds();
  } else throw new Error('For an authorized MyFootage crawl, use the home page or a results.asp search URL.');

  let completed = 0, expected = seeds.length;
  const wait = () => delayMs > 0 ? new Promise(resolve => setTimeout(resolve, delayMs)) : Promise.resolve();
  for (const seed of seeds) {
    const cookieJar = createCookieJar(), seenPageUrls = new Set(), seenPageFingerprints = new Set();
    let tallies = null, pageCount = 1;
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      if (completed) await wait();
      const pageUrl = resultsPageUrl(seed, tallies, pageNumber);
      if (seenPageUrls.has(pageUrl)) throw new Error('MyFootage repeated a continuation URL instead of advancing.');
      seenPageUrls.add(pageUrl);
      const parsed = parseResultsPage(await fetchText(pageUrl, fetchImpl, signal, cookieJar), pageUrl);
      if (pageNumber === 1) {
        pageCount = Math.max(1, Number(parsed.tallies.NumPages) || 1);
        expected += pageCount - 1;
      }
      const declaredPage = Number(parsed.tallies.CurrentPage);
      if (declaredPage && declaredPage !== pageNumber) throw new Error(`MyFootage returned page ${declaredPage} while page ${pageNumber} was requested.`);
      const pageIds = parsed.items.map(item => item.id);
      const pageFingerprint = pageIds.join(',');
      if (pageNumber > 1 && pageIds.length && seenPageFingerprints.has(pageFingerprint)) throw new Error('MyFootage repeated an earlier result page instead of advancing. The session was not preserved.');
      if (pageIds.length) seenPageFingerprints.add(pageFingerprint);
      for (const item of parsed.items) if (!rows.has(item.id)) rows.set(item.id, item);
      tallies = parsed.tallies;
      completed++;
      await writeCatalog(output, start.href, [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id)), authorizedAt);
      onProgress({ stage: 'pages', completed, total: expected, reels: rows.size });
    }
  }
  const items = [...rows.values()].sort((a, b) => Number(a.id) - Number(b.id));
  await writeCatalog(output, start.href, items, authorizedAt);
  return { file: output, total: items.length, pages: completed, sourceKey: 'myfootage', label: 'MyFootage' };
}

module.exports = {
  BASE,
  isMyFootageUrl,
  itemIdFromUrl,
  isClipUrl,
  canonicalItemUrl,
  assignedJson,
  safeMediaUrl,
  parseResultsPage,
  parseClipPage,
  mediaHint,
  createCookieJar,
  importSelectedClip,
  DEFAULT_DECADES,
  defaultCatalogSeeds,
  catalogSeeds,
  resultsPageUrl,
  crawlAuthorizedCatalog
};
