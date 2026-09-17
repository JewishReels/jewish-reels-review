const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isVisionReviewer, visionReviewers } = require('../ui/model-capabilities.js');
const { listModels, reviewImage } = require('../lib/openrouter.cjs');
const vision = { id: 'test/vision', name: 'Vision', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, pricing: {}, supported: [] };
const candidates = [vision, { ...vision, id: 'test/text-only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }, { id: 'test/vision-in-name-only', name: 'Vision' }, { ...vision, id: 'test/image-generation', architecture: { input_modalities: ['image'], output_modalities: ['text', 'image'] } }, { ...vision, id: 'test/audio-generation', architecture: { input_modalities: ['image'], output_modalities: ['text', 'audio'] } }, { ...vision, id: 'test/vision:batch' }, ...['openrouter/auto', 'openrouter/auto-beta', 'openrouter/free'].map(id => ({ ...vision, id }))];
test('live and cached catalogs only retain image-input text-verdict models, excluding routers and batch/generation entries', () => {
  assert.deepEqual(visionReviewers(candidates).map(m => m.id), ['test/vision']);
  assert.deepEqual(visionReviewers(JSON.parse(JSON.stringify(candidates))).map(m => m.id), ['test/vision']);
  assert.deepEqual(visionReviewers(null), []);
});
test('missing, malformed, or name-only capability metadata fails closed', () => {
  for (const architecture of [null, {}, {input_modalities:'image',output_modalities:['text']}, {input_modalities:['image'],output_modalities:'text'}, {input_modalities:['image'],output_modalities:[]}]) assert.equal(isVisionReviewer({...vision, architecture}), false);
  assert.equal(isVisionReviewer(null), false);
});
test('catalog normalization preserves capability evidence for cached lists', async t => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ data: candidates })));
  const models = await listModels();
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].architecture, vision.architecture);
  assert.deepEqual(visionReviewers(models), models);
  assert.deepEqual(visionReviewers([{...models[0], architecture:undefined}]), []);
});
test('empty or malformed live catalogs cannot become a usable catalog', async t => {
  t.mock.method(global, 'fetch', async () => new Response(JSON.stringify({ data: [{ id:'test/text-only' }] })));
  await assert.rejects(() => listModels(), /no verified image-input/);
});
test('transport refuses nonvision models before logging or sending paid requests', async t => {
  let calls = 0;
  t.mock.method(global, 'fetch', async () => { calls++; throw new Error('Should not send'); });
  for (const model of candidates.slice(1)) await assert.rejects(() => reviewImage({ key:'MOCK', model, image:{data:'PIXELS',mime:'image/png'}, onDiagnostic:()=>{throw new Error('Should not log a sent request');} }), /not verified for image review/);
  assert.equal(calls, 0);
});
