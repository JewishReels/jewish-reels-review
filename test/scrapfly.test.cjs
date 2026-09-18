const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizedKey, publicStatus, isPublicVimeoMetadata, createResolverFetch } = require('../lib/scrapfly.cjs');

test('Scrapfly configuration exposes status without exposing its secret', () => {
  assert.equal(normalizedKey('  abcdefghijklmnop  '), 'abcdefghijklmnop');
  assert.throws(() => normalizedKey('short'), /valid Scrapfly/);
  assert.deepEqual(publicStatus('abcdefghijklmnop', { remembered: true }), { configured: true, remembered: true, environment: false });
});

test('only the public Footage Farm Vimeo metadata endpoints are eligible', () => {
  assert.equal(isPublicVimeoMetadata('https://vimeo.com/footagefarm/videos/search:221466-05/sort:date'), true);
  assert.equal(isPublicVimeoMetadata('https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F123'), true);
  assert.equal(isPublicVimeoMetadata('https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fevil.example%2F123'), false);
  assert.equal(isPublicVimeoMetadata('https://vimeo.com/123456'), false);
  assert.equal(isPublicVimeoMetadata('https://player.vimeo.com/video/123456'), false);
  assert.equal(isPublicVimeoMetadata('https://footagefarm.com/reel-details/a/b/c'), false);
});

test('configured resolver returns target content and does not route a video download', async () => {
  const key = 'secret-scrapfly-key', calls = [];
  const transport = async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'api.scrapfly.io') return new Response(JSON.stringify({ result: { success: true, content: '<li id="clip_123"></li>', status_code: 200, response_headers: { 'content-type': 'text/html' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('VIDEO', { status: 200 });
  };
  const resolver = createResolverFetch({ getApiKey: () => key, fetchImpl: transport, directSpacingMs: 0 });
  const metadata = await resolver('https://vimeo.com/footagefarm/videos/search:reel/sort:date');
  assert.equal(await metadata.text(), '<li id="clip_123"></li>');
  assert.equal(calls[0].hostname, 'api.scrapfly.io');
  assert.equal(calls[0].searchParams.get('key'), key);
  assert.equal(calls[0].searchParams.get('unblocker'), 'true');
  assert.equal(calls[0].searchParams.get('render_js'), 'false');
  assert.equal(calls[0].searchParams.get('retry'), 'true');
  assert.equal(calls[0].searchParams.get('format'), 'raw');
  await resolver('https://vimeo.com/123456');
  assert.equal(calls[1].hostname, 'vimeo.com');
});

test('a direct Vimeo throttle stops the local request stampede and asks for Scrapfly', async () => {
  let calls = 0;
  const resolver = createResolverFetch({ getApiKey: () => '', fetchImpl: async () => { calls++; return new Response('CAPTCHA', { status: 429 }); }, directSpacingMs: 0 });
  await assert.rejects(() => resolver('https://vimeo.com/footagefarm/videos/search:one/sort:date'), error => error.code === 'SCRAPFLY_ACCESS_REQUIRED' && !error.sourceTransient);
  await assert.rejects(() => resolver('https://vimeo.com/footagefarm/videos/search:two/sort:date'), error => error.code === 'SCRAPFLY_ACCESS_REQUIRED');
  assert.equal(calls, 1);
});

test('Scrapfly errors are actionable and never echo the API key', async () => {
  const key = 'private-key-never-log';
  const resolver = createResolverFetch({ getApiKey: () => key, fetchImpl: async () => new Response(JSON.stringify({ result: { success: false, error: { code: 'ERR::THROTTLE::MAX_REQUEST_RATE_EXCEEDED', retryable: true } } }), { status: 429 }), directSpacingMs: 0 });
  await assert.rejects(() => resolver('https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F123'), error => {
    assert.equal(error.sourceTransient, true);
    assert.doesNotMatch(error.message, new RegExp(key));
    return true;
  });
});
test('a nonretryable Scrapfly quota response is not put into an automatic retry loop', async () => {
  const resolver = createResolverFetch({ getApiKey: () => 'abcdefghijklmnop', fetchImpl: async () => new Response(JSON.stringify({ result: { success: false, error: { code: 'ERR::SCRAPE::QUOTA_LIMIT_REACHED', retryable: false } } }), { status: 429 }) });
  await assert.rejects(() => resolver('https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F123'), error => error.status === 400 && !error.sourceTransient);
});

test('Scrapfly requests use no more than two concurrent permits', async () => {
  let active = 0, peak = 0;
  const waiting = [];
  const transport = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => waiting.push(resolve));
    active--;
    return new Response(JSON.stringify({ result: { success: true, content: 'ok', status_code: 200 } }), { status: 200 });
  };
  const resolver = createResolverFetch({ getApiKey: () => 'abcdefghijklmnop', fetchImpl: transport, maxConcurrency: 2 });
  const requests = [1,2,3,4].map(i => resolver(`https://vimeo.com/footagefarm/videos/search:${i}/sort:date`));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(peak, 2);
  waiting.splice(0).forEach(resolve => resolve());
  await new Promise(resolve => setTimeout(resolve, 10));
  waiting.splice(0).forEach(resolve => resolve());
  await Promise.all(requests);
  assert.equal(peak, 2);
});
