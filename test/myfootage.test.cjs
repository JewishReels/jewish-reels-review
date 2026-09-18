const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const M = require('../lib/myfootage.cjs');

test('MyFootage recognizes and canonicalizes only supported clip URLs', () => {
  const cases = [
    ['https://www.myfootage.com/preview.asp?item=109285&badge=true', '109285'],
    ['https://www.myfootage.com/109285-1960s-martin-luther-king-jr.html', '109285'],
    ['https://www.myfootage.com/pix/109/109285-1960s-martin-luther-king-jr.mp4', '109285']
  ];
  for (const [url, id] of cases) {
    assert.equal(M.itemIdFromUrl(url), id);
    assert.equal(M.isClipUrl(url), true);
    assert.equal(M.canonicalItemUrl(url), `https://www.myfootage.com/preview.asp?item=${id}`);
  }
  assert.equal(M.isClipUrl('https://www.myfootage.com/results.asp?x0=1930s'), false);
  assert.equal(M.itemIdFromUrl('https://example.org/preview.asp?item=109285'), null);
  assert.equal(M.itemIdFromUrl('http://www.myfootage.com/preview.asp?item=109285'), null);
});

test('assigned JSON parser handles braces and escaped quotes inside strings without evaluating script', () => {
  const html = '<script>var ResultsItems = [{"ItemID":"4","Caption":"A } \\"quote\\"","Nested":{"a":[1,2]}}]; window.bad = true;</script>';
  assert.deepEqual(M.assignedJson(html, 'ResultsItems'), [{ ItemID: '4', Caption: 'A } "quote"', Nested: { a: [1, 2] } }]);
  assert.equal(M.assignedJson('var ResultsItems = alert(1)', 'ResultsItems'), null);
});

test('results parser keeps video previews, decodes titles, and rejects mismatched media IDs', () => {
  const html = `<script>
    var ResultsTallies = {"NumPix":2,"CurrentPage":1,"NextSearchURL":"W=4&F=1&Step=51"};
    var ResultsItems = [
      {"ItemID":"100547","MediaType":"Video","Caption":"Sonja Henie &amp; Olympics","PRPath":"/pix/100/100547-sonja.mp4","TNPath":"/pix/100/100547_t.jpg"},
      {"ItemID":"100548","MediaType":"Video","Caption":"Wrong link","PRPath":"/pix/100/999999-wrong.mp4"},
      {"ItemID":"100549","MediaType":"Photo","Caption":"Still","PRPath":"/pix/100/100549-still.mp4"}
    ];
  </script>`;
  const result = M.parseResultsPage(html, 'https://www.myfootage.com/results.asp?x0=1930s');
  assert.equal(result.tallies.NumPix, 2);
  assert.deepEqual(result.items, [{
    id: '100547', catalog_id: '100547',
    url: 'https://www.myfootage.com/preview.asp?item=100547',
    title: 'Sonja Henie & Olympics',
    media_url: 'https://www.myfootage.com/pix/100/100547-sonja.mp4',
    thumbnail_url: 'https://www.myfootage.com/pix/100/100547_t.jpg',
    source_page: 'https://www.myfootage.com/results.asp?x0=1930s'
  }]);
});

test('clip parser returns the matching public preview and ignores a mismatched candidate', () => {
  const html = `<html><head>
    <meta property="og:title" content="1960s Martin Luther King Jr. | MyFootage">
    <meta property="og:video" content="/pix/109/999999-wrong.mp4">
    <meta property="og:item_id" content="109285">
  </head><body><script>
    var Meta = {"MetaItemId":"109285","PreviewPath":"https://www.myfootage.com/pix/109/109285-mlk.mp4"};
    var Item = {"ItemID":"109285","ImgCaption":"1960s Martin Luther King Jr.","ImgPreview":"/pix/109/109285-mlk.mp4"};
  </script></body></html>`;
  const parsed=M.parseClipPage(html, 'https://www.myfootage.com/preview.asp?item=109285');
  assert.deepEqual(parsed, {
    id: '109285', catalog_id: '109285',
    url: 'https://www.myfootage.com/preview.asp?item=109285',
    title: '1960s Martin Luther King Jr.',
    media_url: 'https://www.myfootage.com/pix/109/109285-mlk.mp4',
    source_page: 'https://www.myfootage.com/preview.asp?item=109285'
  });
  assert.deepEqual(M.mediaHint(parsed),{provider:'myfootage',url:'https://www.myfootage.com/pix/109/109285-mlk.mp4',referer:'https://www.myfootage.com/preview.asp?item=109285',direct:true,scope:'whole-reel'});
  assert.throws(()=>M.parseClipPage(html,'https://www.myfootage.com/preview.asp?item=999999'),/identity does not match/i);
  assert.throws(()=>M.parseClipPage('<script>var Item={"ItemID":"109285","ItemFound":false};</script>','https://www.myfootage.com/preview.asp?item=109285'),/does not exist/i);
});

test('selected-clip importer writes one isolated MyFootage source and refuses broad crawling', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myfootage-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'myfootage.json');
  const direct = 'https://www.myfootage.com/pix/109/109285-1960s-martin-luther-king-jr.mp4';
  const progress = [];
  const result = await M.importSelectedClip({ startUrl: direct, output, onProgress: value => progress.push(value) });
  assert.equal(result.sourceKey, 'myfootage');
  assert.equal(result.total, 1);
  const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(saved.source.mode, 'selected-clips');
  assert.equal(saved.items[0].url, 'https://www.myfootage.com/preview.asp?item=109285');
  assert.equal(saved.items[0].media_url, direct);
  assert.deepEqual(progress.map(value => value.completed), [0, 1]);
  await assert.rejects(
    M.importSelectedClip({ startUrl: 'https://www.myfootage.com/', output }),
    error => error.code === 'MYFOOTAGE_MANUAL_ONLY' && /does not permit automated catalog crawling/i.test(error.message)
  );
});

test('authorized catalog crawl stays locked without permission and checkpoints declared result pages', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myfootage-authorized-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'myfootage.json'), calls = [];
  const item = (id, caption) => `{"ItemID":"${id}","MediaType":"Video","Caption":"${caption}","PRPath":"/pix/${id.slice(0,3)}/${id}-${caption.toLowerCase()}.mp4"}`;
  const page = (number, items) => `<script>
    var ResultsTallies = {"NumPages":2,"CurrentPage":${number},"PixPerPage":50,"RequestW":"4","RequestF":"0001","NextSearchURL":${number === 1 ? '"W=4&F=0001&Step=51"' : '""'}};
    var ResultsItems = [${items.join(',')}];
  </script>`;
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), cookie: options.headers?.Cookie || '' });
    if (String(url) === 'https://www.myfootage.com/') {
      return new Response('<script>var aValue = ["results.asp?x0=1930s"];</script>', { headers: { 'Set-Cookie': 'discovery=complete; Path=/; Secure' } });
    }
    const continued = String(url).includes('Step=51') && /ASPSESSIONID=authorized-session/.test(options.headers?.Cookie || '');
    const headers = new Headers();
    headers.append('Set-Cookie', 'ASPSESSIONID=authorized-session; Path=/; HttpOnly; Secure');
    headers.append('Set-Cookie', 'lastsearch=1930s; Path=/; Secure');
    return new Response(continued ? page(2, [item('100002', 'Second')]) : page(1, [item('100001', 'First')]), { headers });
  };
  await assert.rejects(
    M.crawlAuthorizedCatalog({ startUrl: 'https://www.myfootage.com/', output, fetchImpl, delayMs: 0 }),
    error => error.code === 'SOURCE_PERMISSION_REQUIRED'
  );
  assert.equal(calls.length, 0, 'locked crawl must not contact the source');
  const progress = [];
  const result = await M.crawlAuthorizedCatalog({ startUrl: 'https://www.myfootage.com/', output, authorized: true, fetchImpl, delayMs: 0, onProgress: value => progress.push(value) });
  assert.equal(result.total, 2);
  assert.equal(result.pages, 2);
  assert.equal(calls.length, 3, 'one home page and two result pages');
  assert.doesNotMatch(calls[2].url, /x0=/);
  assert.match(calls[2].url, /W=4/);
  assert.match(calls[2].url, /F=0001/);
  assert.match(calls[2].url, /Step=51/);
  assert.match(calls[2].cookie, /ASPSESSIONID=authorized-session/);
  assert.match(calls[2].cookie, /lastsearch=1930s/);
  const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(saved.source.mode, 'authorized-catalog');
  assert.ok(saved.source.authorized_at);
  assert.deepEqual(saved.items.map(row => row.id), ['100001', '100002']);
  assert.deepEqual(progress.at(-1), { stage: 'pages', completed: 2, total: 2, reels: 2 });
});

test('MyFootage pagination follows the declared continuation without carrying the decade filter', () => {
  const seed = 'https://www.myfootage.com/results.asp?x0=1930s';
  assert.equal(M.resultsPageUrl(seed, {
    PixPerPage: 50,
    RequestW: '4',
    RequestF: '0001',
    NextSearchURL: 'W=4&F=0001&Step=51'
  }, 2), 'https://www.myfootage.com/results.asp?W=4&F=0001&Step=51');
  assert.throws(() => M.resultsPageUrl(seed, {
    PixPerPage: 50,
    RequestW: '4',
    RequestF: '0001',
    NextSearchURL: 'W=4&F=0001&Step=51&x0=1930s'
  }, 2), /inconsistent next-page fields/i);
});

test('MyFootage home catalog seed discovery reads Vue page data and prefers decade searches', () => {
  const html = `<script>
    var aTitle = ["1880s", "1930s"];
    var aValue = ["results.asp?x0=1880s", "results.asp?x0=1930s"];
  </script>
  <a href="/results.asp?search=vintage">Vintage</a>
  <a href="https://elsewhere.test/results.asp?x0=1940s">Other</a>`;
  assert.deepEqual(M.catalogSeeds(html), [
    'https://www.myfootage.com/results.asp?x0=1880s',
    'https://www.myfootage.com/results.asp?x0=1930s'
  ]);
});

test('MyFootage has stable decade seeds when the homepage exposes no catalog markup', () => {
  const seeds = M.defaultCatalogSeeds();
  assert.equal(seeds.length, 15);
  assert.equal(seeds[0], 'https://www.myfootage.com/results.asp?x0=1880s');
  assert.equal(seeds.at(-1), 'https://www.myfootage.com/results.asp?x0=2020s');
  assert.deepEqual(M.catalogSeeds('<html><body>Temporarily minimal home page</body></html>'), []);
});

test('MyFootage catalog seed discovery rejects unrelated and malformed result searches', () => {
  const html = `<script>var aValue = [
    "results.asp?search=vintage",
    "results.asp?x0=1930s&Step=51",
    "results.asp?x0=1930s&x0=1940s",
    "http://www.myfootage.com/results.asp?x0=1950s",
    "https://example.org/results.asp?x0=1960s",
    "results.asp?x0=1920ss"
  ];</script>`;
  assert.deepEqual(M.catalogSeeds(html), []);
});

test('authorized MyFootage crawl uses stable decade fallback when home page discovery is empty', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'myfootage-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'myfootage.json'), calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url) === 'https://www.myfootage.com/') return new Response('<html><body>No rendered links</body></html>');
    const decade = new URL(url).searchParams.get('x0');
    const index = M.DEFAULT_DECADES.indexOf(decade);
    const id = String(200000 + index);
    return new Response(`<script>
      var ResultsTallies = {"NumPages":1,"CurrentPage":1,"PixPerPage":50,"RequestW":"4","RequestF":"0001"};
      var ResultsItems = [{"ItemID":"${id}","MediaType":"Video","Caption":"${decade}","PRPath":"/pix/${id.slice(0,3)}/${id}-${decade}.mp4"}];
    </script>`);
  };
  const result = await M.crawlAuthorizedCatalog({
    startUrl: 'https://www.myfootage.com/', output, authorized: true, fetchImpl, delayMs: 0
  });
  assert.equal(result.total, 15);
  assert.equal(result.pages, 15);
  assert.equal(calls.length, 16, 'one home page and all 15 known decade result pages');
  const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.equal(saved.items.length, 15);
  assert.equal(saved.items[0].title, '1880s');
  assert.equal(saved.items.at(-1).title, '2020s');
});
