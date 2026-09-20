const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const A = require('../lib/public-archives.cjs');
const { resolveMedia } = require('../lib/media.cjs');

test('Prelinger cursor catalog imports every movie beyond one page without crawling archive.org HTML', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prelinger-catalog-')), output = path.join(root, 'prelinger.json'), calls = [];
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fetchImpl = async value => {
    const url = new URL(value); calls.push(url);
    assert.equal(url.hostname, 'archive.org'); assert.equal(url.pathname, '/services/search/v1/scrape');
    if (!url.searchParams.has('cursor')) return new Response(JSON.stringify({ total: 3, cursor: 'next', items: [{ identifier: 'film-a', title: 'Film A' }, { identifier: 'film-b', title: 'Film B' }] }), { status: 200 });
    assert.equal(url.searchParams.get('cursor'), 'next');
    return new Response(JSON.stringify({ total: 3, items: [{ identifier: 'film-c', title: 'Film C' }] }), { status: 200 });
  };
  const result = await A.crawlPrelinger({ output, fetchImpl });
  assert.deepEqual({ total: result.total, pages: result.pages, key: result.sourceKey }, { total: 3, pages: 2, key: 'prelinger' });
  const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual(saved.items.map(row => [row.catalog_id, row.url]), [['film-a', 'https://archive.org/details/film-a'], ['film-b', 'https://archive.org/details/film-b'], ['film-c', 'https://archive.org/details/film-c']]);
  assert.equal(calls.length, 2);
});

test('Library of Congress catalog creates a separate item for every public MP4 resource', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loc-catalog-')), output = path.join(root, 'loc.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fetchImpl = async value => {
    const url = new URL(value); assert.equal(url.hostname, 'www.loc.gov'); assert.equal(url.searchParams.get('fo'), 'json');
    return new Response(JSON.stringify({ pagination: { total: 1, of: 1, next: null }, results: [{ url: 'https://www.loc.gov/item/abc123/', title: 'Historic film', resources: [{ video: 'https://tile.loc.gov/storage/a.mp4' }, { files: [{ video: 'https://tile.loc.gov/storage/b.mp4' }] }, { video: 'https://example.com/not-allowed.mp4' }] }] }), { status: 200 });
  };
  const result = await A.crawlLoc({ output, fetchImpl });
  assert.equal(result.total, 2); assert.equal(result.catalogTotal, 1);
  const saved = JSON.parse(await fs.readFile(output, 'utf8'));
  assert.deepEqual(saved.items.map(row => [row.catalog_id, row.url, row.title]), [
    ['abc123:0', 'https://www.loc.gov/item/abc123/?resource=0', 'Historic film · part 1'],
    ['abc123:1', 'https://www.loc.gov/item/abc123/?resource=1', 'Historic film · part 2']
  ]);
});

test('Library of Congress catalog splits a broken large page without dropping its neighboring records', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loc-split-')), output = path.join(root, 'loc.json'), calls = [];
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = (start, count) => Array.from({ length: count }, (_, index) => { const id = `item-${start + index}`; return { url: `https://www.loc.gov/item/${id}/`, title: id, resources: [{ video: `https://tile.loc.gov/storage/${id}.mp4` }] }; });
  const fetchImpl = async value => {
    const url = new URL(value), count = Number(url.searchParams.get('c')), page = Number(url.searchParams.get('sp')), start = (page - 1) * count; calls.push([start, count]);
    if (start === 100 && count === 100) return new Response('broken page', { status: 404 });
    return new Response(JSON.stringify({ pagination: { total: Math.ceil(200 / count), of: 200, next: start + count < 200 ? 'next' : null }, results: records(start, Math.min(count, 200 - start)) }), { status: 200 });
  };
  const result = await A.crawlLoc({ output, fetchImpl });
  assert.equal(result.total, 200); assert.equal(result.skipped, 0);
  assert.ok(calls.some(([start, count]) => start === 100 && count === 50));
  assert.ok(calls.some(([start, count]) => start === 150 && count === 50));
});

test('Prelinger item resolution chooses a public MP4 and retains verified fallbacks', async () => {
  const fetchImpl = async value => {
    assert.equal(String(value), 'https://archive.org/metadata/film-a');
    return new Response(JSON.stringify({ files: [
      { name: 'film-a_thumb.mp4', format: 'MPEG4', source: 'derivative', size: '1000' },
      { name: 'film-a_512kb.mp4', format: '512Kb MPEG4', source: 'derivative', size: '12000000' },
      { name: 'film-a.mp4', format: 'h.264', source: 'original', size: '90000000' }
    ] }), { status: 200 });
  };
  const resolved = await resolveMedia('https://archive.org/details/film-a', undefined, fetchImpl);
  assert.equal(resolved.provider, 'prelinger');
  assert.equal(resolved.url, 'https://archive.org/download/film-a/film-a_512kb.mp4');
  assert.deepEqual(resolved.alternates.map(row => row.url), ['https://archive.org/download/film-a/film-a.mp4']);
});

test('Library of Congress item resolution selects the cataloged resource index', async () => {
  const fetchImpl = async value => {
    assert.equal(String(value), 'https://www.loc.gov/item/abc123/?fo=json');
    return new Response(JSON.stringify({ resources: [{ video: 'https://tile.loc.gov/storage/a.mp4' }, { video: 'https://tile.loc.gov/storage/b.mp4' }] }), { status: 200 });
  };
  const resolved = await resolveMedia('https://www.loc.gov/item/abc123/?resource=1', undefined, fetchImpl);
  assert.deepEqual(resolved, { provider: 'loc-national-screening-room', url: 'https://tile.loc.gov/storage/b.mp4', referer: 'https://www.loc.gov/item/abc123/', direct: true, scope: 'whole-reel' });
});
