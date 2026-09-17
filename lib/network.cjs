const { redact } = require('./diagnostics.cjs');
const transientCodes = new Set(['UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET','ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','EAI_AGAIN','ENOTFOUND','ENETUNREACH','EHOSTUNREACH']);
const connectCodes = new Set(['UND_ERR_CONNECT_TIMEOUT','ECONNREFUSED','EAI_AGAIN','ENOTFOUND','ENETUNREACH','EHOSTUNREACH']);
function connectionError(cause, phase = 'request') {
  const causes = [], seen = new Set();
  function visit(error, depth = 0) {
    if (!error || seen.has(error) || depth > 4 || causes.length >= 12) return;
    seen.add(error); causes.push({name:redact(error.name),code:redact(error.code),message:redact(error.message),syscall:redact(error.syscall)});
    visit(error.cause, depth + 1); if (Array.isArray(error.errors)) for (const child of error.errors) visit(child, depth + 1);
  }
  visit(cause);
  const codes = causes.map(e=>e.code).filter(Boolean);
  const permanent = causes.some(e=>/CERT|TLS|SSL|INVALID_URL|INVALID_ARG|ACCESS_DENIED/.test(e.code) || e.name === 'AbortError');
  const transient = !permanent && (codes.some(c=>transientCodes.has(c)) || causes.some(e=>e.name==='TimeoutError') || (!codes.length && causes.some(e=>/^(fetch failed|network timeout)$/i.test(e.message))));
  const beforeSend = phase === 'request' && codes.length > 0 && codes.every(c=>connectCodes.has(c));
  const detail = codes.join(', ') || causes.at(-1)?.message || 'unknown network error';
  const error = new Error(`OpenRouter connection failed (${detail}).`);
  Object.assign(error,{code:transient?'TRANSIENT_NETWORK':'NETWORK_FAILURE',transient,network:{phase,causes},billingUncertain:!beforeSend,retryKind:'connection'});
  return error;
}
module.exports = { connectionError };
