const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const S = require('../lib/storage.cjs');

async function fixture(t, ledger) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'verdict-supersede-'));
  await fs.mkdir(path.join(root, 'frames', 'ff-1', 'cards'), { recursive: true });
  await fs.writeFile(path.join(root, 'frames', 'ff-1', 'cards', 'card_000001.jpg'), 'pixels');
  await fs.writeFile(path.join(root, 'chat_verdicts.json'), JSON.stringify(ledger));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('superseded verdict remains in the audit ledger and no longer completes discovery', async t => {
  const original = { id: 'ff-1', verdict: 'jewish', source_fingerprint: 'old', title: 'Wrong reel' };
  const root = await fixture(t, [original]);
  const result = await S.supersedeVerdicts(root, ['ff-1'], 'Legacy Footage Farm media was associated with the wrong catalog row.', { migration: 'footagefarm-media-v1' });
  assert.deepEqual(result.ids, ['ff-1']);
  const ledger = await S.loadLedger(root);
  assert.equal(ledger.entries.length, 0);
  assert.equal(ledger.history.length, 1);
  assert.match(ledger.history[0].superseded_at, /^\d{4}-/);
  assert.equal(ledger.history[0].superseded_reason, 'Legacy Footage Farm media was associated with the wrong catalog row.');
  assert.equal(ledger.history[0].superseded_migration, 'footagefarm-media-v1');
  const view = await S.discover(root);
  assert.deepEqual(view.entries, []);
  assert.deepEqual(view.videos.map(video => video.id), ['ff-1']);

  const replacement = { id: 'ff-1', verdict: 'no', source_fingerprint: 'correct' };
  assert.equal((await S.appendVerdict(root, replacement)).added, true);
  const after = await S.loadLedger(root);
  assert.equal(after.history.length, 2);
  assert.equal(after.entries[0].source_fingerprint, 'correct');
  assert.equal((await S.appendVerdict(root, { ...replacement, verdict: 'jewish' })).added, false);
});

test('ID-keyed legacy ledgers switch to a duplicate-safe array envelope on replacement', async t => {
  const root = await fixture(t, { 'ff-1': { verdict: 'jewish', source_fingerprint: 'old' } });
  await S.supersedeVerdicts(root, ['ff-1'], 'Incorrect legacy association.');
  await S.appendVerdict(root, { id: 'ff-1', verdict: 'no', source_fingerprint: 'new' });
  const raw = JSON.parse(await fs.readFile(path.join(root, 'chat_verdicts.json'), 'utf8'));
  assert.ok(Array.isArray(raw.verdicts));
  assert.equal(raw.verdicts.length, 2);
  assert.equal(raw.verdicts.filter(entry => !entry.superseded_at).length, 1);
});
