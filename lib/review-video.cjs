const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inputOperation } = require('./recovery.cjs');

// Each permit owns a region review. The selected mode controls permit capacity.
// All workers settle before the caller commits a verdict or permits cleanup.
async function reviewVideo({ engine, root, video, cp, saveCheckpoint, key, primary, secondary, verificationMode, detail, workers, budget, runStartSpend, requestGate, feedbackContext }) {
  const policy = engine.policy || require('./policy.cjs');
  const { VERSION, validateResult, corroborates } = policy;
  const hits = [];
  let failure = null;
  const latchFailure = error => {
    const isolated = e => !!(e?.inputUnavailable || e?.videoBlocked || e?.videoRetryable);
    if (!failure || (isolated(failure) && !isolated(error))) failure = error;
    if (!isolated(error)) engine.stopError ||= error;
  };
  const active = new Map(), cardCounts = new Map();
  const touched = new Set(cp.completedCards);
  for (const [name, saved] of Object.entries(cp.regions)) if (saved.primary) touched.add(name.split(':')[0]);
  const stopped = () => hits.length > 0 || !!failure || !!engine.stopError || engine.pauseRequested;
  const publish = () => engine.updateVideo(video.id, { active: [...active.values()], completedCards: cp.completedCards.length });
  const publishRegions = () => engine.updateVideo(video.id, { regionsSaved: Object.values(cp.regions).filter(r => r.primary && (!secondary || r.secondary || (verificationMode === 'positives' && r.primary.decision === 'no'))).length });
  publishRegions();
  const feedbackReference=require('./feedback.cjs').reference(feedbackContext);
  const audit = record => fs.appendFile(path.join(root, 'logs', 'reelsight_reviews.jsonl'), JSON.stringify({ at: new Date().toISOString(), policy: VERSION, id: video.id, feedback: feedbackReference, ...record }) + '\n');
  const account = data => engine.account(data);
  function budgetReached() {
    if (engine.state.spend - runStartSpend < budget) return false;
    if (!engine.pauseRequested) engine.event('Run budget reached. No new requests will start; in-flight requests may add cost.', 'warning');
    engine.pauseRequested = true;
    engine.update({ status: 'pausing', message: 'Budget reached. Saving in-flight reviews…' });
    return true;
  }
  async function completeCard(card) {
    if (cp.completedCards.includes(card)) return;
    cp.completedCards.push(card); cp.completedCards.sort();
    engine.update({ cardsReviewed: engine.state.cardsReviewed + 1 });
    engine.updateVideo(video.id, { completedCards: cp.completedCards.length });
    await saveCheckpoint({wait:requestGate.mode!=='concurrent'});
  }
  // Async-generator next() calls are serialized, so preparation stays bounded
  // and two workers never claim the same region.
  async function* jobs() {
    for (let cardIndex = 0; cardIndex < video.cards.length; cardIndex++) {
      if (stopped()) return;
      const cardPath = video.cards[cardIndex], card = path.basename(cardPath);
      if (cp.completedCards.includes(card)) continue;
      const regions = await inputOperation(() => video.screening ? engine.frameFilter.prepareSheet(root,video.screening.sheets[cardIndex]) : engine.prepareCard(cardPath, detail));
      if (!regions.length) throw new Error(`No readable image regions in ${card}.`);
      cardCounts.set(card, { total: regions.length, complete: 0 });
      for (let regionIndex = 0; regionIndex < regions.length; regionIndex++) {
        if (stopped()) return;
        // Revisit saved regions to apply the same policy; this also supports v1 checkpoints.
        yield { cardPath, card, cardIndex, region: regions[regionIndex], regionIndex, regionsTotal: regions.length };
      }
    }
  }
  const source = jobs();
  async function worker(workerId) {
    try {
      while (!stopped()) {
        // Claim global capacity before decoding cards, bounding memory across videos.
        const releaseJob = await requestGate.acquire(() => stopped() || budgetReached(), video.id);
        if (!releaseJob) return;
        workerId = releaseJob.workerId;
        let current;
        try {
        const next = await source.next();
        if (next.done || stopped()) return;
        const job = next.value;
        const { card, cardPath, cardIndex, region, regionIndex, regionsTotal } = job;
        const regionKey = `${card}:${regionIndex}`;
        const saved = cp.regions[regionKey] || {};
        current = { id: video.id, card_path:path.relative(root,cardPath), title: video.title, worker: workerId, card, cardIndex: cardIndex + 1, cardsTotal: video.cards.length, region: regionIndex + 1, regionsTotal };
        if (stopped() || budgetReached()) return;
        engine.updateVideo(video.id, { current, status: 'reviewing' });
        const waitOwn = async ms => {
          const until = requestGate.now() + ms;
          while (!stopped() && requestGate.now() < until) await requestGate.sleep(Math.min(200, Math.max(0, until - requestGate.now())));
          return !stopped();
        };
        const invoke = async (model, role) => {
          if (saved[role]) return saved[role];
          let rateRetries = 0, formatRetries = 0, connectionRetries = 0, providerRetries = 0, formatFallbacks = 0, formatMode = engine.outputModes.get(model.id), formatIssue;
          while (true) {
            if (!await requestGate.begin(() => stopped() || budgetReached())) return null;
            let result, requestSucceeded = false;
            try {
            active.set(workerId, { id: video.id, worker: workerId, card, cardIndex: cardIndex + 1, region: regionIndex + 1, model: model.id, role });
            publish();
            engine.updateVideo(video.id, { current });
            engine.update({ message: requestGate.mode === 'concurrent' ? `${engine.state.videos.length} video(s) in progress · ${engine.state.activeRequests} image requests active` : `${video.id} · worker ${workerId} reviewing; other workers wait for its saved result` });
            engine.live(root, { models: [primary.id, secondary?.id].filter(Boolean) });
            // A sibling may have found a hit or reached the budget while the log was written.
            if (stopped() || budgetReached()) return null;
            if (requestGate.cooling()) continue;
            try {
              result = await engine.reviewer({ key, model, image: region, policy, feedbackContext, formatRetry: formatRetries > 0, formatMode, formatIssue, onDiagnostic: async record => {
                if (record.event === 'request_started') engine.update({ attempts: (engine.state.attempts || 0) + 1 });
                if (record.event === 'request_failed' || record.error) engine.update({ failedRequests: (engine.state.failedRequests || 0) + 1 });
                await fs.appendFile(path.join(root, 'logs', 'reelsight_transport.jsonl'), JSON.stringify({ at: new Date().toISOString(), dispatch_mode: requestGate.mode, id: video.id, card, region: regionIndex + 1, worker: workerId, role, ...record }) + '\n');
                if (record.billing_uncertain) { engine.usage.ingest(record, record.request_id); engine.update(engine.usage.snapshot()); }
              } });
              requestSucceeded = true;
            } catch (error) {
              error.reviewImage=current;
              if (error.videoBlocked) error.blockedImage = { card, card_path:path.relative(root,cardPath), region: regionIndex + 1, model: model.id, role, request_id: error.diagnostic?.request_id };
              // Rate limits pause the pool. A single incomplete or dropped response waits on this image only.
              const providerFailure=error.retryKind==='provider';
              const connectionDelay = error.transient && !stopped() ? Math.max((providerFailure ? engine.rateLimitOptions.providerBaseMs ?? 2000 : engine.rateLimitOptions.networkBaseMs ?? 2000) * 2 ** (providerFailure ? providerRetries : connectionRetries),error.retryAfterMs||0) : 0;
              const retryDelay = error.status === 429 && !stopped() ? requestGate.throttle(error.retryAfterMs) : 0;
              if (error.accounting) {
                error.accounting = { ...error.accounting, request_id: error.accounting.request_id || error.diagnostic?.request_id || randomUUID() };
                await account(error.accounting);
              }
              await audit({ card, region: regionIndex + 1, role, model: model.id, error: error.message, error_code: error.code, validation_issue: error.validationIssue, status: error.status, provider: error.provider, provider_message: error.providerMessage, provider_detail: error.providerDetail, request_id: error.diagnostic?.request_id, network: error.network, billing_uncertain: error.billingUncertain, rejected_response: error.invalidResponse, ...error.accounting });
              if (error.code === 'OUTPUT_FORMAT_UNSUPPORTED' && formatFallbacks < 2 && ['json','prompt'].includes(error.fallbackMode) && !stopped()) {
                formatMode = error.fallbackMode; formatFallbacks++;
                // Keep the most permissive negotiated provider format for this run.
                // Every answer still crosses the same strict local validator.
                if (engine.outputModes.get(model.id) !== 'prompt') engine.outputModes.set(model.id,formatMode);
                engine.event(`${model.name || model.id}: provider rejected the requested output format. Retrying the same image using ${formatMode === 'json' ? 'JSON mode' : 'prompted JSON'} with full local validation.`, 'warning');
                await audit({ card, region: regionIndex + 1, role, model: model.id, output_format_fallback: formatMode, format_fallback: formatFallbacks });
                continue;
              }
              if (error.transient) {
                if (stopped()) return null;
                if(providerFailure){
                  if(providerRetries<3){
                    providerRetries++;
                    engine.update({providerRetries:(engine.state.providerRetries||0)+1,message:`Provider response incomplete. Retrying ${video.id} · ${card}, region ${regionIndex+1}…`});
                    engine.event(`${video.id} · ${card}, region ${regionIndex+1}: ${error.message} Same-image retry ${providerRetries}/3 in ${Math.ceil(connectionDelay/1000)}s.`, 'warning');
                    await audit({card,region:regionIndex+1,role,provider_retry:providerRetries,retry_after_ms:connectionDelay,request_id:error.diagnostic?.request_id});
                    engine.live(root); if (connectionDelay && !await waitOwn(connectionDelay)) return null; continue;
                  }
                  error.videoRetryable=true;
                  error.message=`Provider did not complete ${video.id} · ${card}, region ${regionIndex+1} after 3 automatic retries. Saved regions are retained; this video will be retried later while other ready videos continue. ${error.message}`;
                  throw error;
                }
                if (connectionRetries < 3) {
                  connectionRetries++;
                  engine.update({ networkRetries: (engine.state.networkRetries || 0) + 1, message: 'Connection interrupted. Waiting before retrying the same image…' });
                  engine.event(`${video.id} · ${card}, region ${regionIndex + 1}: ${error.message} Retry ${connectionRetries}/3 in ${Math.ceil(connectionDelay / 1000)}s.${error.billingUncertain ? ' The provider did not report whether this attempt was billed.' : ''}`, 'warning');
                  await audit({ card, region: regionIndex + 1, role, connection_retry: connectionRetries, retry_after_ms: connectionDelay, request_id: error.diagnostic?.request_id });
                  engine.live(root); if (connectionDelay && !await waitOwn(connectionDelay)) return null; continue;
                }
                error.videoRetryable = true;
                error.retryKind = 'network';
                error.message = `Connection failed after 3 automatic retries for ${video.id} · ${card} · region ${regionIndex + 1}. Completed image reviews are saved. This video will retry automatically while other ready videos continue. ${error.message}`;
              }
              if (stopped() && error.status === 429) return null;
              if (error.code === 'INVALID_VISUAL_RESULT') {
                if (formatRetries < 2 && !stopped()) {
                  formatRetries++;
                  formatIssue = error.validationIssue;
                  engine.update({ formatRetries: engine.state.formatRetries + 1 });
                  engine.event(`${video.id} · ${card}, region ${regionIndex + 1}: invalid verdict; re-reading the same image (${formatRetries}/2).`, 'warning');
                  continue;
                }
                // A sibling isolated failure or pause already stopped this video.
                // Do not escalate a format error into a session-wide stop.
                if (stopped()) return null;
                error.videoRetryable = true;
                error.message = `Model returned invalid verdicts after 2 retries for ${video.id} · ${card} · region ${regionIndex + 1}. Completed reviews are saved. This video will be retried later while other ready videos continue. Last error: ${error.message}`;
                throw error;
              }
              // Explicit provider throttling has a separate retry allowance.
              if (error.status === 429) {
                if (rateRetries < 6 && retryDelay <= 600000) {
                  rateRetries++;
                  engine.update({ retries: engine.state.retries + 1, message: 'Provider rate limit. Waiting before automatically retrying…' });
                  engine.event(`Rate limit · ${requestGate.mode === 'concurrent' ? `worker ${workerId} waits while other workers continue` : `worker ${workerId} holds the queue`}; retrying this image in ${Math.ceil(retryDelay / 1000)}s. Retry ${rateRetries}/6.`, 'warning');
                  await audit({ card, region: regionIndex + 1, role, retry: rateRetries, retry_after_ms: retryDelay, effective_workers: requestGate.limit });
                  engine.live(root);
                  if (retryDelay && !await waitOwn(retryDelay)) return null;
                  continue;
                }
                error.message = `Provider is still rate-limiting ${model.name || model.id} ${requestGate.mode === 'concurrent' ? `with up to ${workers} concurrent requests` : 'with only one request at a time'}. Completed image reviews are saved. Wait at least ${Math.ceil(retryDelay / 1000)} seconds, then resume. ${retryDelay > 600000 ? 'The requested wait exceeds the automatic retry window.' : 'Six automatic retries were exhausted for this image.'}`;
              }
              throw error;
            }
            } finally { requestGate.finished({success:requestSucceeded}); active.delete(workerId); publish(); }
            result = { ...result, request_id: result.request_id || randomUUID() };
            await account(result);
            validateResult(result);
            saved[role] = result; cp.regions[regionKey] = saved;
            if (role === 'primary') engine.update({ regionsReviewed: (engine.state.regionsReviewed || 0) + 1 });
            publishRegions();
            if (role === 'primary') { touched.add(card); if(video.screening)engine.updateScreening(video.id,{reviewed:video.screening.sheets.filter(s=>cp.regions[s.name+':0']?.primary).reduce((n,s)=>n+s.frames.length,0)}); }
            await audit({ card, region: regionIndex + 1, bounds: region.bounds, role, ...result });
            await saveCheckpoint({wait:requestGate.mode!=='concurrent'});
            return result;
          }
        };
        const first = await invoke(primary, 'primary');
        if (!first) return;
        const needsSecond = secondary && (verificationMode !== 'positives' || first.decision === 'hit');
        const second = needsSecond ? await invoke(secondary, 'secondary') : null;
        if (needsSecond && !second) return;
        const accepted = secondary ? !!second && corroborates(first, second) : first.decision === 'hit';
        if (accepted) {
          const evidence = { card, region: regionIndex + 1, bounds: region.bounds, imageSize: region.imageSize, ...(region.frameMap?{frame_map:region.frameMap}:{}), primary: first, secondary: second, card_path: path.relative(root, cardPath) };
          if (!hits.some(value => value.card === evidence.card && value.region === evidence.region)) {
            hits.push(evidence);
            hits.sort((a,b)=>a.card.localeCompare(b.card,undefined,{numeric:true})||a.region-b.region);
          }
          if (hits.length === 1) {
            engine.update({ message: `${video.id} · strict hit found. Saving requests already in flight…` });
          }
          return;
        }
        if ((first.decision === 'hit' || second?.decision === 'hit') && !saved.disagreementCounted) {
          cp.disagreements++; saved.disagreementCounted = true;
          engine.update({ disagreements: engine.state.disagreements + 1 });
          engine.event(`${video.id} · ${card}: positive not corroborated; continuing under unsure → no`, 'warning');
        }
        const counts = cardCounts.get(card);
        counts.complete++;
        if (counts.complete === counts.total) await completeCard(card);
        else await saveCheckpoint({wait:requestGate.mode!=='concurrent'});
        engine.live(root);
        } catch (error) {
          error.reviewImage ??= current;
          // Latch failure before releasing the next worker, even if saving fails.
          latchFailure(error); throw error;
        } finally { releaseJob(); }
      }
    } catch (error) {
      latchFailure(error);
      engine.update({ message: 'A worker stopped. Saving the remaining in-flight reviews…' });
    } finally { active.delete(workerId); publish(); }
  }
  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));
  await source.return();
  publish();
  await saveCheckpoint({ wait: true });
  await engine.live(root, {}, { wait: true });
  // Even when another worker found a hit, surface failures before committing.
  // Its successful review remains checkpointed and can be reused on resume.
  if (failure) throw failure;
  return { hit: hits[0] || null, hits, touched };
}
module.exports = { reviewVideo };
