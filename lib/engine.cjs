const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const S = require('./storage.cjs');
const { reviewVideo } = require('./review-video.cjs');
const { RequestGate } = require('./request-gate.cjs');
const { UsageLedger, ReviewClock } = require('./metrics.cjs');
const R = require('./recovery.cjs');
const F = require('./feedback.cjs');
const FC = require('./frame-filter-config.cjs');
const FF = require('./frame-filter.cjs');

class ReviewEngine extends EventEmitter {
  constructor({ reviewer, prepareCard, frameFilter, rateLimitOptions = {}, recoveryOptions = {} }) {
    super(); this.frameFilter = frameFilter; this.reviewer = reviewer; this.prepareCard = prepareCard; this.rateLimitOptions = rateLimitOptions; this.recoveryOptions = { baseMs: 5000, maxMs: 120000, pollMs: 1000, ...recoveryOptions }; this.running = false; this.pauseRequested = false;
    this.state = { status: 'idle', message: 'Choose a project to get started', total: 0, done: 0, hits: 0, cardsReviewed: 0, regionsReviewed: 0, requests: 0, spend: 0, estimated: false, disagreements: 0, workers: 1, activeRequests: 0, active: [], retries: 0, formatRetries: 0, completedCardsCurrent: 0, current: null, events: [] };
  }
  update(changes) {
    if (changes.status) this.clock?.setActive(['running', 'pausing'].includes(changes.status));
    Object.assign(this.state, changes, this.clock?.snapshot());
    this.emit('state', this.snapshot({includeDeferred:Object.prototype.hasOwnProperty.call(changes,'deferred')}));
  }
  updateScreening(id, changes) {
    const current = this.screeningProgress.get(id) || {screened:0,selected:0,skipped:0,reviewed:0};
    this.screeningProgress.set(id,{...current,...changes});
    const values=[...this.screeningProgress.values()];
    this.update({framesScreened:values.reduce((n,v)=>n+v.screened,0),framesSelected:values.reduce((n,v)=>n+v.selected,0),framesSkipped:values.reduce((n,v)=>n+v.skipped,0),framesReviewed:values.reduce((n,v)=>n+v.reviewed,0)});
  }
  snapshot({includeDeferred=true}={}) {
    const value={...this.state,...this.clock?.snapshot()};
    if(!includeDeferred)delete value.deferred;
    return JSON.parse(JSON.stringify(value));
  }
  updateVideo(id, changes) {
    const old = this.videoStates.get(id) || { id, active: [], completedCards: 0, regionsSaved: 0 };
    this.videoStates.set(id, { ...old, ...changes });
    this.publishVideos(changes.current);
  }
  publishVideos(latest) {
    const videos = [...this.videoStates.values()];
    const active = videos.flatMap(v => v.active || []);
    const current = latest || this.state.current;
    const focus = videos.find(v => v.id === current?.id) || videos[0];
    this.update({ videos, active, activeRequests: active.length,
      current: focus?.current || (focus ? { id: focus.id, title: focus.title, cardsTotal: focus.cardsTotal } : current),
      completedCardsCurrent: focus ? Math.min(focus.completedCards || 0, focus.cardsTotal || Infinity) : this.state.completedCardsCurrent, regionsReviewedCurrent: focus ? focus.regionsSaved || 0 : this.state.regionsReviewedCurrent });
  }
  async openWorkspace(root) {
    if (this.usage?.root === root) return;
    this.usage = await new UsageLedger(root).load(); this.clock = new ReviewClock();
    this.update({ ...this.usage.snapshot(), spend: 0, estimated: false, requests: 0, attempts: 0, failedRequests: 0, networkRetries: 0, providerRetries:0, cardsReviewed: 0, regionsReviewed: 0, retries: 0, formatRetries: 0 });
  }
  async account(data) {
    const writing = this.usage.record({ cost: data.cost || 0, estimated: !!data.estimated, request_id: data.request_id, generation: data.generation, model: data.model });
    this.update({ requests: this.state.requests + 1, spend: this.state.spend + (data.cost || 0), estimated: this.state.estimated || !!data.estimated, ...this.usage.snapshot() });
    await writing;
  }
  event(message, kind = 'info') {
    this.state.events.unshift({ at: new Date().toISOString(), message, kind }); this.state.events = this.state.events.slice(0, 80); this.update({});
  }
  pause() { this.pauseRequested = true; this.update({ status: 'pausing', message: 'Saving in-flight images, then pausing…' }); }
  live(root, detail = {}, { wait = false } = {}) {
    this.liveValue = { method: 'reelsight-openrouter', updated_at: new Date().toISOString(), status: this.state.status,
      id: this.state.current?.id || null, card: this.state.current?.card || null, region: this.state.current?.region || null,
      videos: this.state.videos || [], video_concurrency: this.state.videoConcurrency || 1, workers: this.state.workers, rate_limit: this.state.rateLimit,
      deferred: (this.state.deferred || []).filter(v=>!v.manual), manual_deferred_count:(this.state.deferred || []).filter(v=>v.manual).length,
      active_requests: this.state.active, cards_completed: this.state.completedCardsCurrent, regions_saved: this.state.regionsReviewedCurrent || 0, attempts: this.state.attempts || 0, failed_requests: this.state.failedRequests || 0, connection_retries: this.state.networkRetries || 0, provider_retries:this.state.providerRetries||0, ...detail };
    if (!this.liveFlushing) {
      this.liveFlushing = true;
      this.liveWrites = (this.liveWrites || Promise.resolve()).catch(() => {}).then(async () => {
        while (this.liveValue) {
          const value = this.liveValue;
          this.liveValue = null;
          await S.atomicJson(path.join(root, 'logs', 'inspect_live.json'), value);
        }
        this.liveFlushing = false;
      });
    }
    return wait ? this.liveWrites : Promise.resolve();
  }
  async run({ root, key, primary, secondary, verificationMode = 'all', detail = true, budget = 10, workers = 1, videoConcurrency = 1, dispatchMode = 'one-at-a-time', followPreparation = null, policy, frameFilter: filterSettings, sourceKey = null }) {
    if (this.running) throw new Error('A review is already running.');
    if (!key) throw new Error('Add an OpenRouter API key in Settings.');
    if (!primary?.id) throw new Error('Select a vision model.');
    if (secondary?.id === primary.id) throw new Error('Choose a different model for independent verification.');
    if (!['all','positives'].includes(verificationMode)) throw new Error('Choose a valid verification mode.');
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('Enter a positive run budget.');
    if (!Number.isInteger(workers) || workers < 1 || workers > 128) throw new Error('Choose between 1 and 128 review workers.');
    if (!['one-at-a-time', 'concurrent'].includes(dispatchMode)) throw new Error('Choose Take turns or Run concurrently.');
    if (!Number.isInteger(videoConcurrency) || videoConcurrency < 1 || videoConcurrency > 16) throw new Error('Choose between 1 and 16 videos at once.');
    const filterConfig=FC.normalize(filterSettings);
    this.screeningProgress=new Map();
    this.update({framesScreened:0,framesSelected:0,framesSkipped:0,framesReviewed:0,filterEnabled:filterConfig.enabled});
    this.running = true; this.pauseRequested = false; this.stopError = null; this.outputModes = new Map(); this.videoStates = new Map(); this.commitWrites = Promise.resolve();
    const tasks = new Map();
    const requestGate = new RequestGate({ ...this.rateLimitOptions, workers, mode: dispatchMode, onChange: rateLimit => this.update({ rateLimit }) });
    this.update({ workers, videoConcurrency, videos: [], dispatchMode, rateLimit: requestGate.snapshot(), activeRequests: 0, active: [], completedCardsCurrent: 0, regionsReviewedCurrent: 0 });
    let unlock, project;
    let runStartSpend;
    const activePolicy = policy?.VERSION ? policy : require('./policy.cjs');
    this.policy = activePolicy;
    const configKey = S.sha(JSON.stringify({ policy: activePolicy.VERSION, primary: primary.id, secondary: secondary?.id || null, verificationMode: secondary ? verificationMode : null, detail, ...(filterConfig.enabled ? {frameFilter:filterConfig} : {}) }));
    try {
      unlock = await S.acquireLock(root);
      await this.openWorkspace(root);
      runStartSpend = this.state.spend;
      project = await S.discover(root,{sourceKey});
      const judged = new Map(project.entries.map(e => [String(e.id), e]));
      const deferredPath = path.join(root, 'logs', 'reelsight_deferred.json');
      const savedDeferred = await S.readJson(deferredPath, { version: 1, videos: [] });
      if (savedDeferred.version !== 1 || !Array.isArray(savedDeferred.videos)) throw new Error('Invalid deferred-work journal. Preserved for diagnosis.');
      const deferred = new Map(savedDeferred.videos.filter(v => v?.id && !judged.has(String(v.id))).map(v => {
        const sourceChanged = v.code === 'INPUT_UNAVAILABLE' && /Source video differs from its prepared receipt/i.test(v.message || '');
        const providerContent = /Output data may contain inappropriate content/i.test(v.provider_message || v.message || '');
        const manual = sourceChanged || providerContent || (v.recovery_kind === 'filter' ? false : !!v.manual);
        return [String(v.id), { ...v,
          ...(sourceChanged ? { code:'INPUT_UNAVAILABLE', recovery_kind:'source_changed', message:'Source video differs from its prepared receipt. Re-prepare this video before reviewing it.' } : {}),
          ...(providerContent ? { code:'PROVIDER_CONTENT_REJECTED', recovery_kind:'provider_content' } : {}),
          manual, next_retry_at: manual ? null : 0
        }];
      }));
      const autoDeferred = () => [...deferred.values()].filter(v => !v.manual);
      let deferredWrites = Promise.resolve();
      const saveDeferred = async () => {
        const videos = [...deferred.values()];
        deferredWrites = deferredWrites.then(() => S.atomicJson(deferredPath, { version: 1, videos }));
        this.update({ deferred: videos });
        await deferredWrites;
      };
      const defer = async issue => {
        const attempts = (deferred.get(issue.id)?.attempts || 0) + 1;
        const delay = Math.min(this.recoveryOptions.maxMs, this.recoveryOptions.baseMs * 2 ** Math.min(attempts - 1, 10));
        const item = { ...issue, attempts, next_retry_at: issue.manual ? null : Date.now() + delay };
        deferred.set(issue.id, item); await saveDeferred();
        await R.logRecovery(root, { event: issue.manual ? 'video-needs-manual-review' : 'video-deferred', ...item });
        this.event(`${issue.id} · ${issue.code}: ${issue.message} ${issue.manual ? 'Preserved for manual review; no automatic resend.' : `Other ready videos continue; retrying in ${Math.ceil(delay / 1000)}s.`}`, 'warning');
      };
      const resolved = async id => {
        if (!deferred.delete(id)) return;
        await saveDeferred(); await R.logRecovery(root, { event: 'video-recovered', id });
        this.event(`${id} · recovered automatically; saved review progress retained.`);
      };
      const recordDiscovery = async fresh => {
        for (const issue of fresh.issues || []) if (!judged.has(issue.id) && !deferred.get(issue.id)?.manual) await defer(issue);
        for (const recovery of fresh.recoveries || []) {
          if (!this.receiptRecoveries.has(recovery.id)) {
            this.receiptRecoveries.add(recovery.id); await R.logRecovery(root, recovery);
            this.event(`${recovery.id} · using the verified durable preparation receipt.`, 'warning');
          }
        }
      };
      this.receiptRecoveries = new Set(); await saveDeferred(); await recordDiscovery(project);
      const hits = project.entries.filter(e => e.verdict === 'jewish').length;
      const pendingCount = videos => new Set([...videos.filter(v => !judged.has(v.id)).map(v => v.id), ...deferred.keys()]).size;
      this.update({ status: 'running', message: 'Checking existing verdicts and shared reels…', total: judged.size + pendingCount(project.videos), done: judged.size, hits, current: null });
      this.event(`Review started · ${primary.name}${secondary ? ' + ' + secondary.name : ''} · ${workers} worker${workers === 1 ? '' : 's'} across up to ${videoConcurrency} videos · ${dispatchMode === 'concurrent' ? 'run concurrently' : 'take turns'}`);
      const cpPath = path.join(root, 'logs', 'reelsight_checkpoint.json');
      let checkpoint = await S.readJson(cpPath, { version: 1, videos: {} });
      if (checkpoint.version !== 1 || !checkpoint.videos || typeof checkpoint.videos !== 'object') throw new Error('Unsupported checkpoint format. Keep the file for diagnosis.');
      let checkpointWrites = Promise.resolve(), checkpointDirty = false, checkpointScheduled = false;
      const saveCheckpoint = ({ wait = false } = {}) => {
        checkpointDirty = true;
        // Many responses can finish in the same provider wave. Cloning the
        // entire multi-video checkpoint once per response caused hundreds of
        // MB of allocations at 128 workers. One scheduled writer snapshots the
        // newest state and folds all progress arriving during its write into a
        // following snapshot.
        const schedule = delay => {
          if (checkpointScheduled) return;
          checkpointScheduled = true;
          checkpointWrites = checkpointWrites.then(async () => {
            if (delay) await R.sleep(delay);
            do {
              checkpointDirty = false;
              const value = JSON.parse(JSON.stringify(checkpoint));
              await S.atomicJson(cpPath, value);
            } while (checkpointDirty);
            checkpointScheduled = false;
          });
        };
        schedule(wait ? 0 : 100);
        if (!wait) return Promise.resolve();
        return (async () => {
          while (checkpointDirty || checkpointScheduled) {
            const pending = checkpointWrites; await pending;
            if (checkpointDirty && !checkpointScheduled) schedule(0);
          }
        })();
      };
      const fingerprints = new Map();
      for (const entry of project.entries) if (['jewish', 'no', 'filtered_no'].includes(entry.verdict) && entry.source_fingerprint) fingerprints.set(entry.source_fingerprint, entry);
      // Index finished IDs with cards so pre-existing chat verdicts can be reused.
      for (const video of project.videos) {
        if (this.pauseRequested) break;
        const old = judged.get(video.id);
        if (old && ['jewish', 'no', 'filtered_no'].includes(old.verdict)) {
          try {
            const fingerprint = await S.fingerprintVideo(video);
            if (!fingerprints.has(fingerprint)) fingerprints.set(fingerprint, old);
          } catch (e) {
            await R.logRecovery(root, { event: 'completed-source-unavailable', id: video.id, error: e.message, error_code: e.code });
          }
        }
      }
      const sourceOwners = new Map(), sharedWaiting = new Map();
      let queue = project.videos.filter(v => !deferred.get(v.id)?.manual && !judged.has(v.id));
      const processVideo = async video => {
        let ownedFingerprint;
        try {
        this.updateVideo(video.id, { title: video.title, cardsTotal: video.cards.length, status: 'checking', current: { id: video.id, title: video.title, card: null, cardIndex: 0, cardsTotal: video.cards.length, region: 0, regionsTotal: 0 } });
        await this.live(root);
        const fingerprint = await R.inputOperation(() => S.fingerprintVideo(video));
        if (this.pauseRequested || this.stopError) return;
        if (sourceOwners.has(fingerprint)) {
          sharedWaiting.set(video.id, { video, fingerprint });
          this.event(video.id + ' · waiting to reuse the verdict for identical footage already being reviewed.');
          return;
        }
        sourceOwners.set(fingerprint, video.id); ownedFingerprint = fingerprint;
        const heldSource = [...deferred.values()].find(v => v.manual && v.source_fingerprint === fingerprint);
        if (heldSource) {
          await defer({ ...heldSource, id: video.id, title: video.title, url: video.url, copied_from: heldSource.id, message: `Same source pixels as ${heldSource.id}, which requires manual review after a provider refusal.`, attempts: undefined });
          return;
        }
        const cardSignature = await R.inputOperation(() => S.fingerprintCards(video));
        const feedbackContext = await F.workspaceContext(root),feedbackReference=F.reference(feedbackContext);
        const videoConfigKey = feedbackContext.revision ? S.sha(JSON.stringify({ configKey, feedback: feedbackContext.revision })) : configKey;
        let expectedFilterKey=null;
        if(filterConfig.enabled){if(!this.frameFilter)throw FF.fail('The bundled filter is unavailable.');const a=await this.frameFilter.ready();expectedFilterKey=FC.fingerprint(filterConfig,a.hash);}
        let shared = video.sharedFrom ? judged.get(String(video.sharedFrom)) : fingerprints.get(fingerprint);
        if (shared?.filter && (!filterConfig.enabled || shared.review_config !== videoConfigKey || shared.filter.key !== expectedFilterKey || (!video.sharedFrom && shared.filter.card_signature !== cardSignature))) shared=null;
        if (video.sharedFrom && (!shared || shared.source_fingerprint !== fingerprint)) throw FF.fail('The shared clip has different filter settings. Prepare this story again to review it.');
        if (shared) {
          const entry = { ...shared, id: video.id, title: video.title, url: video.url, source_key:video.prepared?.source_key||null, scope:video.scope, segment_start:video.segment_start, segment_end:video.segment_end, cards_reviewed: [], cards_reviewed_count: 0, method: 'shared-reel-copy', copied_from: String(shared.id), source_fingerprint: fingerprint, reviewed_at: new Date().toISOString(), summary: `Same source pixels as ${shared.id}. ${shared.summary || ''}` };
          // The inherited evidence belongs to the source ID; preserve its full relative path.
          await this.commit(root, entry, judged, fingerprints);
          await resolved(video.id);
          this.event(`${video.id} · reused ${shared.verdict} from ${shared.id}`, 'reuse'); return;
        }
        // Keep the same feedback snapshot through screening and independent review.
        let screening=null, reviewInput=video;
        if(filterConfig.enabled){
          if(!this.frameFilter)throw FF.fail('The local frame filter is unavailable. Reinstall this build.');
          this.updateVideo(video.id,{status:'screening'});
          try{screening=await this.frameFilter.screen({root,video,config:filterConfig,reusePrepared:true,sourceFingerprint:fingerprint,cardSignature,stopped:()=>this.pauseRequested||this.stopError,onProgress:p=>{this.updateScreening(video.id,p);this.update({message:p.prepared?video.id+' · using prepared People filter · '+p.selected+' candidates':video.id+' · screening '+p.screened+'/'+p.total+' frames locally · '+p.selected+' candidates'});}});}
          catch(e){if(e.filterCancelled)return;throw FF.fail(e.message);}
          reviewInput={...video,cards:screening.sheets.map(s=>path.resolve(root,s.path)),screening};
        }
        const finalConfigKey=screening?FC.hash({videoConfigKey,manifest:screening.fingerprint}):videoConfigKey;
        let cp = checkpoint.videos[video.id];
        if (cp && cp.configKey !== finalConfigKey) this.event(`${video.id} · review settings or feedback checks changed; restarting unfinished coverage to apply them consistently.`);
        if (!cp || cp.configKey !== finalConfigKey || cp.fingerprint !== fingerprint || cp.cardSignature !== cardSignature) cp = checkpoint.videos[video.id] = { configKey: finalConfigKey, fingerprint, cardSignature, feedback: feedbackReference, completedCards: [], regions: {}, disagreements: 0 };
        this.updateVideo(video.id, { completedCards: cp.completedCards.length });
        if(screening)this.updateScreening(video.id,{reviewed:screening.sheets.filter(s=>cp.regions[s.name+':0']?.primary).reduce((n,s)=>n+s.frames.length,0)});
        const { hit, hits, touched } = await reviewVideo({ engine: this, root, video:reviewInput, cp, saveCheckpoint, key, primary, secondary, verificationMode, detail, workers, budget, runStartSpend, requestGate, feedbackContext });
        await saveCheckpoint({ wait: true });
        if (this.stopError || (this.pauseRequested && !hit)) return;
        if (!hit && cp.completedCards.length !== reviewInput.cards.length) throw new Error('Coverage incomplete. Refusing to save a no verdict.');
        // Detect card edits, additions, removals, or metadata reel changes during a run.
        const namesNow = (await R.inputOperation(() => R.retryIO(() => fs.readdir(path.dirname(video.cards[0]), { withFileTypes: true })))).filter(f => f.isFile() && /^card_.*\.jpe?g$/i.test(f.name)).map(f => path.join(path.dirname(video.cards[0]), f.name)).sort(S.natural);
        const now = { ...video, cards: namesNow };
        if (!now || JSON.stringify(now.cards) !== JSON.stringify(video.cards) || await R.inputOperation(() => S.fingerprintVideo(now)) !== fingerprint || await R.inputOperation(() => S.fingerprintCards(now)) !== cardSignature) throw new Error('Source images changed during review. Resume to inspect the updated source; no verdict was saved.');
        if(screening){
          const p=path.resolve(root,screening.manifest_path.replace(/\.json$/,'.reviews.json'));
          await S.atomicJson(p,{version:1,manifest_fingerprint:screening.fingerprint,regions:cp.regions,completed_sheets:cp.completedCards});
        }
        const entry = { id: video.id, source_key:video.prepared?.source_key||null, review_config:videoConfigKey, ...(screening?{filter:{key:screening.filter_key,card_signature:cardSignature,config:screening.config,manifest_path:screening.manifest_path,manifest_fingerprint:screening.fingerprint,validation:screening.validation,frames_screened:screening.frame_count,frames_selected:screening.selected_count,frames_reviewed:screening.sheets.filter(s=>cp.regions[s.name+':0']?.primary).reduce((n,s)=>n+s.frames.length,0),reviewed_sheets:[...cp.completedCards]},coverage_mode:'filtered'}:{}), verdict: hit ? 'jewish' : screening ? 'filtered_no' : 'no', cues: hit ? [...new Set(hits.flatMap(value=>[value.primary.cue,value.secondary?.cue]).filter(Boolean))] : [],
          summary: hit ? hit.primary.evidence : screening ? `No confirmed hit — filtered review. Screened ${screening.frame_count} frames locally; selected and reviewed ${screening.selected_count}. Skipped frames were not classified by the AI.` : `All ${video.cards.length} cards inspected; no ${secondary ? 'corroborated ' : ''}strict visible cue.${cp.disagreements ? ` ${cp.disagreements} uncorroborated candidate region(s); unsure → no.` : ''}`,
          confidence: hit ? Math.min(hit.primary.confidence, hit.secondary?.confidence ?? 1) : null,
          confidence_note: 'Subjective model score, not a measured probability of correctness.', feedback: feedbackReference,
          cards_reviewed: [...touched].sort(S.natural), cards_reviewed_count: touched.size, cards_total: reviewInput.cards.length,
          method: `openrouter-vision/${activePolicy.VERSION}/${secondary ? verificationMode === 'positives' ? 'independent-hit-confirmation' : 'independent-double' : 'single'}`, models: [primary.id, secondary?.id].filter(Boolean), verification_mode: secondary ? verificationMode : 'none', workers,
          video_concurrency: videoConcurrency, dispatch_mode: dispatchMode, title: video.title, url: video.url, media_url: video.mediaUrl, scope:video.scope, segment_start:video.segment_start, segment_end:video.segment_end, source_fingerprint: fingerprint, reviewed_at: new Date().toISOString(), uncorroborated_regions: cp.disagreements, evidence: hit, ...(hit?{evidence_hits:hits}: {}) };
        await this.commit(root, entry, judged, fingerprints);
        await resolved(video.id);
        delete checkpoint.videos[video.id]; await saveCheckpoint({ wait: true });
        this.event(`${video.id} · ${entry.verdict === 'jewish' ? `${hits.length} strict hit${hits.length===1?'':'s'} saved; remaining cards skipped` : screening ? 'filtered review complete · no confirmed hit' : 'all cards complete · no hit'}`, hit ? 'hit' : 'info');
        } catch (e) {
          // Input failures and exhausted transient generation retries are isolated. Failed verdict/checkpoint/accounting
          // writes must stop new paid requests rather than lose their results.
          if (!e.inputUnavailable && !e.videoBlocked && !e.videoRetryable) throw e;
          await defer({ id: video.id, code: e.code || 'INPUT_UNAVAILABLE', message: e.message, path: e.path, ...(e.manual?{manual:true,recovery_kind:e.recoveryKind||'input'}:{}), ...(e.filterError?{manual:true,recovery_kind:'filter'}:{}), ...(e.videoRetryable?{recovery_kind:e.retryKind==='network'?'network':'provider',provider:e.provider,provider_code:e.providerCode,card:e.reviewImage?.card,region:e.reviewImage?.region}:{}), ...(e.videoBlocked ? { manual: true, recovery_kind:'provider_content', source_fingerprint: checkpoint.videos[video.id]?.fingerprint, provider: e.provider, provider_code: e.providerCode, provider_message: e.providerMessage, title: video.title, url: video.url, ...e.blockedImage } : {}) });
          await this.live(root, {}, { wait: true });
        }
        finally { if (ownedFingerprint) sourceOwners.delete(ownedFingerprint); }
      };
      const launch = video => {
        // A single owner per ID and per exact source; commits share one durable writer.
        const task = processVideo(video).catch(error => {
          // Preserve counters from the same video as the error before its live state is removed.
          // Otherwise another concurrent video's counters can be displayed beside this video's ID.
          const progress = this.videoStates.get(video.id);
          if (error.reviewImage && progress) error.reviewProgress = {
            completedCards: Math.min(progress.completedCards || 0, error.reviewImage.cardsTotal || progress.cardsTotal || Infinity),
            regionsSaved: progress.regionsSaved || 0
          };
          this.stopError ||= error;
        }).finally(() => {
          tasks.delete(video.id); this.videoStates.delete(video.id); this.publishVideos();
          this.emit('video-settled', video.id);
        });
        tasks.set(video.id, task);
      };
      let nextDiscovery = 0;
      while (!this.pauseRequested && !this.stopError) {
        for (const [id, waiting] of sharedWaiting) if (!sourceOwners.has(waiting.fingerprint)) {
          sharedWaiting.delete(id); queue.push(waiting.video);
        }
        while (tasks.size < videoConcurrency && queue.length && !this.pauseRequested && !this.stopError) {
          const video = queue.shift();
          if (!judged.has(video.id) && !tasks.has(video.id) && !sharedWaiting.has(video.id) && !deferred.get(video.id)?.manual) launch(video);
        }
        if (this.pauseRequested || this.stopError) break;
        if (tasks.size < videoConcurrency && !queue.length && (followPreparation || autoDeferred().length) && Date.now() >= nextDiscovery) {
          const skipIds = new Set([...tasks.keys(), ...sharedWaiting.keys(), ...[...deferred.values()].filter(v => v.manual || v.next_retry_at > Date.now()).map(v => v.id)]);
          const fresh = await S.discover(root, { skipIds,sourceKey }); await recordDiscovery(fresh);
          for (const item of [...deferred.values()]) {
            if (!item.manual && item.next_retry_at <= Date.now() && !skipIds.has(item.id) && !fresh.videos.some(v => v.id === item.id) && !fresh.issues.some(v => v.id === item.id)) await defer({ id: item.id, code: 'ENOENT', message: 'Waiting for this video’s complete published cards to become available.' });
          }
          queue = fresh.videos.filter(v => !judged.has(v.id) && !tasks.has(v.id) && !sharedWaiting.has(v.id) && !deferred.get(v.id)?.manual);
          this.update({ total: judged.size + pendingCount([...queue, ...[...tasks.keys()].map(id => ({ id })), ...[...sharedWaiting.keys()].map(id => ({ id }))]), done: judged.size });
          nextDiscovery = Date.now() + this.recoveryOptions.pollMs;
          if (queue.length) continue;
        }
        if (tasks.size) {
          // Refill newly published footage even if an older video's requests are slow.
          await Promise.race([...tasks.values(), R.sleep(this.recoveryOptions.pollMs)]); continue;
        }
        if (sharedWaiting.size) continue;
        const preparation = followPreparation?.();
        if (!autoDeferred().length && preparation && typeof preparation === 'object' && preparation.status === 'error') throw new Error('Footage preparation stopped: ' + preparation.message + ' Completed reviews are saved; resume preparation and review to continue.');
        if (autoDeferred().length || (typeof preparation === 'object' ? preparation?.running : preparation)) {
          this.update({ status: 'running', current: null, message: autoDeferred().length ? autoDeferred().length + ' video(s) waiting for provider or file recovery. Retrying automatically; Pause remains available.' : 'Waiting for the footage producer to publish complete cards…' });
          await this.live(root, {}, { wait: true }); await R.sleep(this.recoveryOptions.pollMs); continue;
        }
        break;
      }
      // Keep the workspace lock until every video's in-flight review is saved.
      await Promise.all(tasks.values());
      if (this.stopError) throw this.stopError;
      const paused = this.pauseRequested;
      this.update({ status: paused ? 'paused' : deferred.size ? 'attention' : 'complete', message: paused ? 'Paused. Completed image reviews are saved; resume when ready.' : deferred.size ? `Available reviews finished. ${deferred.size} video(s) still need manual review; their images and saved progress are preserved.` : 'Review complete. Every eligible ID has a verdict.', ...(paused ? {} : { current: null }) });
      await this.live(root, {}, { wait: true });
    } catch (e) {
      this.stopError ||= e; await Promise.all(tasks.values());
      this.update({ status: 'error', message: e.message, ...(e.reviewImage ? {
        current: e.reviewImage,
        completedCardsCurrent: e.reviewProgress?.completedCards || 0,
        regionsReviewedCurrent: e.reviewProgress?.regionsSaved || 0
      } : {}) }); this.event(e.message, 'error');
      if (project) await this.live(root, { error: e.message }, { wait: true }).catch(() => {});
    } finally {
      try { if (unlock) await unlock(); }
      catch (e) { this.update({ status: 'error', message: `Work saved, but the review lock could not be released: ${e.message}` }); }
      finally { this.running = false; this.update({}); }
    }
    return this.snapshot();
  }
  async commit(root, entry, judged, fingerprints) {
    this.commitWrites = (this.commitWrites || Promise.resolve()).then(() => S.appendVerdict(root, entry));
    const result = await this.commitWrites;
    if (result.added) this.clock.finish(result.entry.method === 'shared-reel-copy');
    judged.set(String(entry.id), result.entry);
    if (['jewish', 'no', 'filtered_no'].includes(result.entry.verdict)) fingerprints.set(entry.source_fingerprint, result.entry);
    this.update({ done: this.state.done + Number(result.added), hits: this.state.hits + (result.added && result.entry.verdict === 'jewish' ? 1 : 0) });
    this.emit('verdict', result.entry);
  }
}
module.exports = { ReviewEngine };
