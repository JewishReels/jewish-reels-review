const { PROMPT, SCHEMA, validateResult } = require('./policy.cjs');
const { randomUUID } = require('node:crypto');
const { providerError, imageInfo, redact } = require('./diagnostics.cjs');
const { isVisionReviewer, visionReviewers } = require('../ui/model-capabilities.js');
const { connectionError } = require('./network.cjs');
const { CONTRACT_VERSION, parseReview, invalid, outputMode, fallbackMode, imageInstruction } = require('./output-contract.cjs');
const { isContentRejection, contentRejection, generationFailure } = require('./provider-errors.cjs');
const BASE = 'https://openrouter.ai/api/v1';
const TRANSIENT_HTTP = new Set([408, 500, 502, 503, 504]);
const transientHttp = status => TRANSIENT_HTTP.has(status) || (status >= 500 && status <= 599);
const feedbackPrompt = require('./feedback.cjs').prompt;
function retryAfterMs(response) {
  const retry = response.headers?.get?.('Retry-After');
  const seconds = retry == null ? NaN : Number(retry);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now()) || 0;
}
async function listModels(key = '') {
  const response = await fetch(`${BASE}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw new Error(`OpenRouter model list returned HTTP ${response.status}.`);
  const body = await response.json();
  const models = visionReviewers(body.data);
  if (!models.length) throw new Error('OpenRouter returned no verified image-input, text-output review models. Refresh the model list before reviewing.');
  return models.map(m => ({ id: m.id, name: m.name || m.id, architecture: { input_modalities: [...m.architecture.input_modalities], output_modalities: [...m.architecture.output_modalities] }, pricing: m.pricing || {}, supported: m.supported_parameters || [], context: m.context_length, maxOutput: m.top_provider?.max_completion_tokens || 8192 })).sort((a, b) => a.name.localeCompare(b.name));
}
const parseContent = parseReview;
async function requestImage({ key, model, image, contextImage, signal, formatRetry = false, formatIssue, formatMode, feedbackContext, onDiagnostic = async () => {} }, task) {
  if (!image?.data || !/^image\/(jpeg|png)$/.test(image.mime)) throw new Error('Missing image pixels; refusing a text-only classification.');
  if(contextImage&&(!contextImage.data||!/^image\/(jpeg|png)$/.test(contextImage.mime)))throw new Error('Invalid context image.');
  if (!isVisionReviewer(model)) throw new Error('The selected model is not verified for image review. Refresh the vision model dropdown before sending images.');
  const payload = {
    model: model.id,
    messages: [{ role: 'system', content: task?.system || PROMPT + feedbackPrompt(feedbackContext) }, { role: 'user', content: [
      { type: 'text', text: task?.instruction || imageInstruction(image, formatRetry, formatIssue) },
      { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}`, detail: 'high' } },
      ...(contextImage ? [{type:'image_url',image_url:{url:`data:${contextImage.mime};base64,${contextImage.data}`,detail:'high'}}] : [])
    ] }],
    max_tokens: Math.min(task?.maxTokens || 8192, model.maxOutput || 8192),
    // Backup providers may serve the exact selected model; never substitute a model.
    provider: { require_parameters: true, allow_fallbacks: true }
  };
  const mode = outputMode(model, formatMode);
  if (model.supported?.includes('temperature')) payload.temperature = 0;
  if (mode === 'schema') payload.response_format = { type: 'json_schema', json_schema: task?.schema || SCHEMA };
  else if (mode === 'json') payload.response_format = { type: 'json_object' };
  const requestId = randomUUID(), started = Date.now();
  await onDiagnostic({ event: 'request_started', request_id: requestId, model: model.id, max_tokens: payload.max_tokens, response_format: payload.response_format?.type, output_contract: task?.version || CONTRACT_VERSION, output_mode: mode, format_retry: formatRetry, validation_issue: formatIssue, image: imageInfo(image), ...(contextImage?{context_image:imageInfo(contextImage)}:{}) });
  let response;
  try { response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Jewish Reels' }, body: JSON.stringify(payload), signal: signal || AbortSignal.timeout(180000)
  }); } catch (cause) {
    const error = connectionError(cause);
    error.diagnostic = { event: 'request_failed', request_id: requestId, model: model.id, elapsed_ms: Date.now() - started, error: redact(error.message), error_code: error.code, network: error.network, retryable: error.transient, billing_uncertain: error.billingUncertain };
    await onDiagnostic(error.diagnostic);
    throw error;
  }
  let body;
  try { body = await response.json(); } catch (cause) {
    const network = connectionError(cause, 'response-body');
    // Gateway HTML (Cloudflare/nginx 502 pages) is the same class as a JSON 5xx: retry the image.
    if (transientHttp(response.status) || response.status === 429) {
      const error = response.status === 429
        ? Object.assign(new Error('OpenRouter or its provider is temporarily rate-limiting requests.'), { status: 429 })
        : generationFailure({ provider: 'OpenRouter', message: `unreadable HTTP ${response.status} response (${redact(cause.message)})`, status: response.status });
      error.retryAfterMs = retryAfterMs(response);
      error.billingUncertain = true;
      error.network = network.network;
      error.diagnostic = { event: 'request_failed', request_id: requestId, model: model.id, http_status: response.status, elapsed_ms: Date.now() - started, error: error.message, error_code: error.code, network: error.network, retryable: true, billing_uncertain: true };
      await onDiagnostic(error.diagnostic);
      throw error;
    }
    if (!network.transient) network.message = `OpenRouter returned an unreadable response (HTTP ${response.status}). ${network.message}`;
    network.status = response.status;
    network.diagnostic = { event: 'request_failed', request_id: requestId, model: model.id, http_status: response.status, elapsed_ms: Date.now() - started, error: network.message, error_code: network.code, network: network.network, retryable: network.transient, billing_uncertain: true };
    await onDiagnostic(network.diagnostic);
    throw network;
  }
  const choice = body.choices?.[0];
  // Some provider failures arrive inside a successful HTTP response or choice.
  const responseError = body.error || choice?.error || choice?.message?.error;
  const details = responseError ? providerError(typeof responseError==='string'?{message:responseError}:responseError) : null;
  const incomplete = choice?.finish_reason === 'error';
  const refused = choice?.message?.refusal || choice?.finish_reason==='content_filter' || isContentRejection({},choice?.native_finish_reason);
  const diagnostic = { event: 'response_received', request_id: requestId, model: model.id, generation: body.id || '', http_status: response.status, elapsed_ms: Date.now() - started, provider: body.provider || responseError?.metadata?.provider_name || '', finish_reason: choice?.finish_reason, native_finish_reason: choice?.native_finish_reason, retry_after: response.headers?.get('Retry-After'), trace_id: response.headers?.get('x-request-id'), cost: body.usage?.cost, prompt_tokens: body.usage?.prompt_tokens, completion_tokens: body.usage?.completion_tokens,
    ...(details ? { error:details } : incomplete ? {error:{error_type:'incomplete_generation',message:'Provider ended the response with finish_reason=error.'}} : {}),
    ...(incomplete ? { response_excerpt:redact(choice?.message?.content), billing_uncertain:typeof body.usage?.cost!=='number' } : {}) };
  try { await onDiagnostic(diagnostic); } catch (error) { if (typeof body.usage?.cost === 'number') error.accounting = { cost: body.usage.cost, estimated: false }; throw error; }
  if (!response.ok || responseError) {
    const numericCode = Number(responseError?.code);
    const typedStatus={server:500,timeout:408,rate_limit_exceeded:429,content_policy:403,content_policy_blocked:403};
    const code = numericCode >= 100 && numericCode <= 599 ? numericCode : typedStatus[diagnostic.error?.error_type] || response.status;
    const details = diagnostic.error || {};
    // A provider can report its internal image-fetch failure as HTTP 400.
    // Retry only this explicit transport message, never generic bad parameters.
    const mediaFetchFailure = code === 400 && /failed to download multimodal content/i.test(details.provider_message || details.message || '');
    const message = code == 401 ? 'OpenRouter API key was rejected. Update it in Settings.' : code == 402 ? 'OpenRouter has insufficient credits.' : code == 429 ? 'OpenRouter or its provider is temporarily rate-limiting requests.' : `${details.provider || body.provider || 'OpenRouter'} (HTTP ${code}${details.provider_code ? `, ${details.provider_code}` : ''}): ${details.provider_message || details.message || 'Provider returned an error.'}`;
    const error = refused || isContentRejection(details, responseError?.code) ? contentRejection({ provider: details.provider || body.provider, code: details.provider_code || choice?.native_finish_reason || responseError?.code, message: choice?.message?.refusal || details.provider_message || details.message }) : mediaFetchFailure || transientHttp(code) ? generationFailure({provider:details.provider || body.provider,message,status:code,code:details.provider_code}) : new Error(message);
    error.status = code;
    error.provider = details.provider || body.provider || ''; error.providerCode = details.provider_code || error.providerCode || ''; error.providerMessage = details.provider_message || details.message || error.providerMessage || ''; error.providerDetail = details.provider_detail;
    error.diagnostic = diagnostic;
    // Only an explicit output-format rejection can relax provider enforcement.
    // The identical local validation remains mandatory; never infer another model.
    const formatMessage = [responseError?.message, diagnostic.error?.provider_detail].filter(Boolean).join(' ');
    if (!error.videoBlocked && [400,404,422].includes(error.status) && /response[_ -]?format|json[_ -]?schema|structured[_ -]?outputs/i.test(formatMessage) && /unsupported|not supported|invalid|not allowed|no endpoints|not available/i.test(formatMessage)) {
      const nextMode = fallbackMode(model,mode);
      if (nextMode) { error.code = 'OUTPUT_FORMAT_UNSUPPORTED'; error.fallbackMode = nextMode; }
    }
    if (error.status === 429) {
      const redact = value => String(value || '').replace(/sk-or-[\w-]+/g, '[redacted]').slice(0, 350);
      error.provider = redact(responseError?.metadata?.provider_name);
      error.providerMessage = redact(responseError?.message);
      error.providerDetail = details.provider_detail;
    }
    error.retryAfterMs = retryAfterMs(response);
    if (typeof body.usage?.cost === 'number') error.accounting = { cost: body.usage.cost, estimated: false, generation: body.id || '', provider: body.provider || '', model: body.model || model.id };
    throw error;
  }
  const usage = body.usage || {};
  const estimated = typeof usage.cost !== 'number';
  const cost = estimated ? ((usage.prompt_tokens || 0) * Number(model.pricing.prompt || 0) + (usage.completion_tokens || 0) * Number(model.pricing.completion || 0) + Number(model.pricing.request || 0) + Number(model.pricing.image || 0)*(contextImage?2:1)) : usage.cost;
  const accounting = { cost, estimated, request_id: requestId, usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }, provider: body.provider || '', generation: body.id || '', model: body.model || model.id, ...(task&&estimated&&(!Number.isFinite(usage.prompt_tokens)||!Number.isFinite(usage.completion_tokens))?{billing_uncertain:true}:{}) };
  try {
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter' || isContentRejection({},choice?.native_finish_reason)) throw contentRejection({ provider: body.provider || model.name || model.id, code: choice?.native_finish_reason || (choice.finish_reason === 'content_filter' ? 'content_filter' : 'model_refusal'), message: choice.message?.refusal || 'The provider filtered this image review.' });
    if (incomplete) throw generationFailure({provider:body.provider,message:'finish_reason=error',code:choice?.native_finish_reason || 'incomplete_generation'});
    if (choice?.finish_reason === 'length') throw invalid('truncated', choice.message?.content);
    if (!choice || choice.finish_reason !== 'stop' || choice.message?.tool_calls?.length) throw new Error(`Model did not finish a usable review (${choice?.finish_reason || 'missing response'}).`);
    return { ...(task?.parse || parseContent)(choice.message?.content), ...accounting, request_id: requestId, elapsed_ms: Date.now() - started, output_contract: task?.version || CONTRACT_VERSION, output_mode: mode };
  } catch (e) { e.accounting = accounting; e.diagnostic=diagnostic; e.billingUncertain=incomplete && estimated; throw e; }
}
function reviewImage(args) {
  const policy = args.policy || require('./policy.cjs');
  return requestImage(args, {
    system: policy.PROMPT + feedbackPrompt(args.feedbackContext),
    schema: policy.SCHEMA,
    parse: content => parseReview(content, policy.validateResult),
    // Valid six-field verdicts normally finish below 400 tokens. Bound rare
    // runaway generations that otherwise occupy a worker for over a minute.
    maxTokens: 1200
  });
}
function analyzeMistake(args) {
  const L = require('./learning-contract.cjs').forPolicy(args.policy);
  return requestImage(args, { system: L.SYSTEM, instruction: L.instruction(args.caseData, args.formatRetry), schema: L.SCHEMA, parse: L.parse, version: L.VERSION, maxTokens: 2400 });
}
module.exports = { listModels, reviewImage, analyzeMistake, parseContent, visionReviewers };
