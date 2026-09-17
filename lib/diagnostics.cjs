const crypto = require('node:crypto');
function redact(value) {
  return String(value ?? '').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/sk-or-[\w-]+/g, '[redacted]').replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]').slice(0, 1800);
}
function providerError(error) {
  let raw = error?.metadata?.raw;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch {
      // Some upstream errors are returned as an SSE fragment inside the JSON
      // envelope. Extract its structured cause instead of hiding it as text.
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        try { const value = JSON.parse(line.slice(5).trim()); if (value?.error) { raw = value; break; } } catch {}
      }
    }
  }
  const detail = raw?.error || raw;
  return {
    error_type: redact(error?.metadata?.error_type || detail?.type),
    provider_code: redact(error?.metadata?.provider_code || detail?.code),
    provider: redact(error?.metadata?.provider_name),
    message: redact(error?.message),
    provider_message: redact(detail?.message),
    provider_detail: redact(typeof detail === 'object' ? JSON.stringify({ code: detail?.code, message: detail?.message, type: detail?.type }) : detail)
  };
}
function imageInfo(image) {
  const bytes = Buffer.from(image.data, 'base64');
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mime: image.mime, bounds: image.bounds, sheet_size: image.imageSize };
}
module.exports = { redact, providerError, imageInfo };
