const API = 'https://api.scrapfly.io/scrape';

function normalizedKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length < 12 || key.length > 500 || /[\s\u0000-\u001f]/.test(key)) throw new Error('Enter a valid Scrapfly API key.');
  return key;
}

function publicStatus(key, { remembered = false, environment = false } = {}) {
  return { configured: !!String(key || '').trim(), remembered: !!remembered, environment: !!environment };
}

function isPublicVimeoMetadata(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || !/^(?:www\.)?vimeo\.com$/i.test(url.hostname) || url.port || url.username || url.password || url.hash) return false;
    if (/^\/footagefarm\/videos\/search:[^/]+\/sort:date\/?$/i.test(url.pathname)) return true;
    if (url.pathname !== '/api/oembed.json') return false;
    const nested = new URL(url.searchParams.get('url') || 'invalid:');
    return nested.protocol === 'https:' && !nested.port && !nested.username && !nested.password && !nested.search && !nested.hash
      && /^(?:www\.)?vimeo\.com$/i.test(nested.hostname) && /^\/\d+\/?$/.test(nested.pathname);
  } catch { return false; }
}

function abortError() { return Object.assign(new Error('Preparation paused. Partial work is saved.'), { name: 'AbortError' }); }
function wait(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', stopped); resolve(); }
    function stopped() { clearTimeout(timer); signal?.removeEventListener('abort', stopped); reject(abortError()); }
    signal?.addEventListener('abort', stopped, { once: true });
  });
}

class PermitPool {
  constructor(maximum = 2) { this.maximum = maximum; this.active = 0; this.waiters = []; }
  async acquire(signal) {
    if (signal?.aborted) throw abortError();
    if (this.active < this.maximum && !this.waiters.length) { this.active++; return this.release.bind(this); }
    return new Promise((resolve, reject) => {
      const ticket = { resolve, reject, signal };
      ticket.stopped = () => { const at = this.waiters.indexOf(ticket); if (at >= 0) this.waiters.splice(at, 1); reject(abortError()); };
      signal?.addEventListener('abort', ticket.stopped, { once: true });
      this.waiters.push(ticket);
    });
  }
  release() {
    if (this.active > 0) this.active--;
    while (this.waiters.length && this.active < this.maximum) {
      const ticket = this.waiters.shift();
      ticket.signal?.removeEventListener('abort', ticket.stopped);
      if (ticket.signal?.aborted) { ticket.reject(abortError()); continue; }
      this.active++; ticket.resolve(this.release.bind(this));
    }
  }
}

function responseHeaders(value) {
  const headers = new Headers();
  if (Array.isArray(value)) {
    for (const pair of value) if (Array.isArray(pair) && pair.length >= 2) headers.append(String(pair[0]), String(pair[1]));
  } else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) {
    if (Array.isArray(item)) for (const part of item) headers.append(name, String(part));
    else if (item != null) headers.set(name, String(item));
  }
  return headers;
}

function safeScrapflyError(data, fallbackStatus) {
  const remote = data?.result?.error;
  const rawCode = String(remote?.code || '');
  const code = /^[A-Z0-9:_-]{1,160}$/.test(rawCode) ? rawCode : '';
  const retryable = typeof remote?.retryable === 'boolean' ? remote.retryable : fallbackStatus === 429 || fallbackStatus >= 500;
  const error = new Error(code ? `Scrapfly could not fetch public Vimeo metadata (${code}).` : `Scrapfly could not fetch public Vimeo metadata (HTTP ${fallbackStatus || 'error'}).`);
  error.code = code || 'SCRAPFLY_REQUEST_FAILED';
  error.status = retryable ? (fallbackStatus === 429 ? 429 : 503) : 400;
  if (retryable) error.sourceTransient = true;
  return error;
}

function createResolverFetch({ getApiKey = () => '', fetchImpl = fetch, maxConcurrency = 2, directSpacingMs = 750, now = Date.now } = {}) {
  const pool = new PermitPool(maxConcurrency);
  let directBlocked = false, nextDirectAt = 0;
  const resolver = async (input, init = {}) => {
    const target = new URL(String(input));
    if (!isPublicVimeoMetadata(target)) return fetchImpl(input, init);
    if (init.method && String(init.method).toUpperCase() !== 'GET') throw new Error('Scrapfly resolver accepts public metadata GET requests only.');
    const release = await pool.acquire(init.signal);
    try {
      const key = normalizedKey(await getApiKey());
      if (!key) {
        if (directBlocked) {
          const error = new Error('Scrapfly access is required while Vimeo is rate-limiting the public Footage Farm catalog lookup. Add a Scrapfly API key in Connection & settings.');
          error.code = 'SCRAPFLY_ACCESS_REQUIRED'; error.status = 400; throw error;
        }
        const remaining = nextDirectAt - now();
        if (remaining > 0) await wait(remaining, init.signal);
        const response = await fetchImpl(input, init);
        nextDirectAt = now() + directSpacingMs;
        if (response.status === 429) {
          directBlocked = true;
          const error = new Error('Scrapfly access is required while Vimeo is rate-limiting the public Footage Farm catalog lookup. Add a Scrapfly API key in Connection & settings.');
          error.code = 'SCRAPFLY_ACCESS_REQUIRED'; error.status = 400; throw error;
        }
        return response;
      }
      const endpoint = new URL(API);
      endpoint.searchParams.set('key', key);
      endpoint.searchParams.set('url', target.href);
      endpoint.searchParams.set('unblocker', 'true');
      endpoint.searchParams.set('render_js', 'false');
      endpoint.searchParams.set('retry', 'true');
      endpoint.searchParams.set('format', 'raw');
      let response, data;
      try {
        response = await fetchImpl(endpoint, { method: 'GET', headers: { Accept: 'application/json' }, signal: init.signal });
        data = await response.json();
      } catch (cause) {
        if (init.signal?.aborted) throw abortError();
        const error = new Error('Scrapfly connection failed while fetching public Vimeo metadata.');
        error.code = 'SCRAPFLY_CONNECTION_FAILED'; error.status = 503; error.sourceTransient = true; error.cause = cause; throw error;
      }
      if (!response.ok || data?.result?.success !== true) throw safeScrapflyError(data, response.status);
      const status = Number(data.result.status_code || 200);
      const headers = responseHeaders(data.result.response_headers);
      const normalizedStatus=status >= 200 && status <= 599 ? status : 502;
      const content=[204,205,304].includes(normalizedStatus)?null:typeof data.result.content === 'string' ? data.result.content : '';
      return new Response(content, { status: normalizedStatus, headers });
    } finally { release(); }
  };
  resolver.isManagedUrl = value => !!normalizedKey(getApiKey()) && isPublicVimeoMetadata(value);
  resolver.isScrapflyResolver = true;
  return resolver;
}

module.exports = { normalizedKey, publicStatus, isPublicVimeoMetadata, createResolverFetch };
