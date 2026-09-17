const { redact } = require('./diagnostics.cjs');
function isContentRejection(detail, outerCode) {
  const values = [outerCode, detail?.provider_code, detail?.error_type].filter(Boolean).map(String);
  if (values.some(v => /^(data_inspection_failed|content_filter|content_policy_violation|safety_violation|moderation_blocked|content_policy|content_policy_blocked)$/i.test(v))) return true;
  const message = [detail?.provider_message, detail?.message, detail?.provider_detail].filter(Boolean).map(String).join(' ');
  // Some providers return a generic 502 even though moderation ended the request.
  return /(?:output data may contain inappropriate content|inappropriate content|content (?:was )?(?:filtered|blocked|rejected)|(?:safety|moderation|content policy) (?:filter|block|rejection|violation))/i.test(message);
}
function contentRejection({ provider, code, message } = {}) {
  const error = new Error(`${redact(provider) || 'Model provider'} declined this image${code ? ` (${redact(code)})` : ''}: ${redact(message) || 'Content review was refused.'} This video needs manual review; other videos can continue.`);
  return Object.assign(error, { code: 'PROVIDER_CONTENT_REJECTED', videoBlocked: true, provider: redact(provider), providerCode: redact(code), providerMessage: redact(message), retryable: false });
}
function generationFailure({provider, message, status, code}={}) {
  return Object.assign(new Error(`${redact(provider)||'Model provider'} did not complete this image response: ${redact(message)||'generation ended with an error'}.`),{
    code:'TRANSIENT_PROVIDER',transient:true,retryKind:'provider',provider:redact(provider),providerCode:redact(code),providerMessage:redact(message),status
  });
}
module.exports = { isContentRejection, contentRejection, generationFailure };
