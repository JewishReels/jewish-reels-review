const C = require('./criteria.cjs');
const compiled = C.compile();
module.exports = {
  VERSION: compiled.VERSION,
  CUES: compiled.CUES,
  PROMPT: compiled.PROMPT,
  SCHEMA: compiled.SCHEMA,
  validateResult: compiled.validateResult,
  corroborates: compiled.corroborates,
  labels: compiled.labels,
  compile: C.compile,
  defaults: C.defaults,
  normalize: C.normalize,
  withLearnedRules: C.withLearnedRules,
  mergeExistingLearnedRules: C.mergeExistingLearnedRules,
  view: C.view,
  sameAsDefaults: C.sameAsDefaults
};
