const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const V = require('../lib/vimeo-auth.cjs');

test('Vimeo authentication builds bounded yt-dlp arguments without reading credentials', () => {
  const cookies = path.resolve('private', 'vimeo-cookies.txt');
  assert.deepEqual(V.vimeoAuthArgs({ mode: 'cookies-file', path: cookies }), ['--cookies', cookies]);
  assert.deepEqual(V.vimeoAuthArgs({ mode: 'browser', browser: 'edge', profile: 'Profile 1' }), ['--cookies-from-browser', 'edge:Profile 1']);
  assert.deepEqual(V.vimeoAuthArgs({ mode: 'browser', browser: 'chrome' }), ['--cookies-from-browser', 'chrome']);
  assert.deepEqual(V.vimeoAuthArgs({ mode: 'none' }), []);
});

test('Vimeo authentication rejects arbitrary browser names and unsafe profiles', () => {
  assert.throws(() => V.vimeoAuthArgs({ mode: 'browser', browser: 'firefox' }), /Edge or Google Chrome/);
  assert.throws(() => V.vimeoAuthArgs({ mode: 'browser', browser: 'edge', profile: '../Default' }), /cannot contain/);
  assert.throws(() => V.vimeoAuthArgs({ mode: 'cookies-file', path: 'relative.txt' }), /local Netscape-format/);
});

test('renderer-facing status never exposes the cookies file path', () => {
  const file = path.resolve('private', 'vimeo-cookies.txt');
  const status = V.publicVimeoAuth({ mode: 'cookies-file', path: file });
  assert.deepEqual(status, { mode: 'cookies-file', configured: true, fileName: 'vimeo-cookies.txt' });
  assert.equal(JSON.stringify(status).includes(path.dirname(file)), false);
});

test('Vimeo authentication is limited to verified Footage Farm Vimeo resolutions', () => {
  assert.equal(V.isOfficialFootageFarmVimeo({ provider: 'footagefarm-vimeo', url: 'https://vimeo.com/12345' }), true);
  assert.equal(V.isOfficialFootageFarmVimeo({ provider: 'vimeo', url: 'https://vimeo.com/12345' }), false);
  assert.equal(V.isOfficialFootageFarmVimeo({ provider: 'footagefarm-vimeo', url: 'https://example.com/12345' }), false);
});
