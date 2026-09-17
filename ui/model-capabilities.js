(function (root) {
  // Shared by the desktop process and both dropdowns. Missing metadata fails closed.
  function isVisionReviewer(model) {
    const a = model?.architecture;
    return typeof model?.id === 'string' && /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model.id)
      && !['openrouter/auto', 'openrouter/auto-beta', 'openrouter/free'].includes(model.id)
      && !model.id.endsWith(':batch')
      && Array.isArray(a?.input_modalities) && a.input_modalities.includes('image')
      // This app requests text verdicts; omit image/audio generation models.
      && Array.isArray(a.output_modalities) && a.output_modalities.length === 1 && a.output_modalities[0] === 'text';
  }
  function visionReviewers(models) { return Array.isArray(models) ? models.filter(isVisionReviewer) : []; }
  const api = Object.freeze({ isVisionReviewer, visionReviewers });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.modelCapabilities = api;
})(globalThis);
