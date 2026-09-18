const path = require('node:path');

const BROWSERS = new Set(['edge', 'chrome']);

function cleanProfile(value) {
  const profile = String(value || '').trim();
  if (!profile) return '';
  if (profile.length > 100 || /[\r\n:/\\]/.test(profile)) throw new Error('Browser profile names cannot contain slashes, colons, or line breaks.');
  return profile;
}

function normalizeVimeoAuth(value) {
  if (!value || value.mode === 'none') return { mode: 'none' };
  if (value.mode === 'cookies-file') {
    const file = String(value.path || '').trim();
    if (!file || !path.isAbsolute(file)) throw new Error('Choose a local Netscape-format cookies file.');
    return { mode: 'cookies-file', path: path.normalize(file) };
  }
  if (value.mode === 'browser') {
    const browser = String(value.browser || '').toLowerCase();
    if (!BROWSERS.has(browser)) throw new Error('Choose Microsoft Edge or Google Chrome.');
    const profile = cleanProfile(value.profile);
    return { mode: 'browser', browser, ...(profile ? { profile } : {}) };
  }
  throw new Error('Unsupported Vimeo access method.');
}

function vimeoAuthArgs(value) {
  const auth = normalizeVimeoAuth(value);
  if (auth.mode === 'none') return [];
  if (auth.mode === 'cookies-file') return ['--cookies', auth.path];
  return ['--cookies-from-browser', `${auth.browser}${auth.profile ? `:${auth.profile}` : ''}`];
}

function publicVimeoAuth(value) {
  const auth = normalizeVimeoAuth(value);
  if (auth.mode === 'cookies-file') return { mode: auth.mode, configured: true, fileName: path.basename(auth.path) };
  if (auth.mode === 'browser') return { ...auth, configured: true };
  return { mode: 'none', configured: false };
}

function isOfficialFootageFarmVimeo(resolved) {
  if (!resolved || resolved.provider !== 'footagefarm-vimeo') return false;
  try {
    const url = new URL(resolved.url);
    return url.protocol === 'https:' && /(^|\.)vimeo\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

module.exports = { normalizeVimeoAuth, vimeoAuthArgs, publicVimeoAuth, isOfficialFootageFarmVimeo };
