const $ = id => document.getElementById(id);
const api = window.reelsight;
const recoveryNotice = document.createElement('p'); recoveryNotice.id = 'recoveryNotice'; recoveryNotice.className = 'rate-limit-notice'; recoveryNotice.setAttribute('role','status'); recoveryNotice.hidden = true;
document.getElementById('rateLimitNotice').after(recoveryNotice);
const activeVideoList = document.createElement('div'); activeVideoList.id = 'activeVideoList'; activeVideoList.setAttribute('aria-label','Videos in progress'); document.getElementById('workerList').after(activeVideoList);
const manualPanel = document.createElement('section'); manualPanel.id = 'manualReviewPanel'; manualPanel.className = 'card manual-review-panel'; manualPanel.hidden = true;
const manualTitle = document.createElement('h2'), manualNote = document.createElement('p'), manualTable = document.createElement('table'), manualHead = document.createElement('thead'), manualBody = document.createElement('tbody');
manualBody.id = 'manualReviewBody';
manualHead.innerHTML = '<tr><th>Video</th><th>Image</th><th>Provider reason</th><th>Action</th></tr>';
manualTable.append(manualHead,manualBody);manualPanel.append(manualTitle,manualNote,manualTable);document.querySelector('.worker-panel').before(manualPanel);
const verificationModeControl = document.createElement('select');
verificationModeControl.id = 'verificationMode'; verificationModeControl.setAttribute('aria-label','Independent review coverage');
for (const [value,label] of [['positives','Candidate hits only'],['all','Every image region']]) { const option = document.createElement('option'); option.value=value; option.textContent=label; verificationModeControl.append(option); }
const verificationModeLabel=document.createElement('label');verificationModeLabel.className='coverage-label';verificationModeLabel.append(document.createTextNode('Verify '),verificationModeControl);document.querySelector('.config-bottom').append(verificationModeLabel);
let project = null, models = [], entries = [], hitEntries = [], knownSources = [], selectedFilter = 'jewish', state = {}, connected = false, prefs = {}, currentEvidence = null, resultPage = 0;
let preparation = { counts: {} }, modelsLoading = false;
const isFalseHit = entry => entry.human_review?.status === 'false_hit';
const isConfirmedHit = entry => entry.human_review?.status === 'confirmed_hit';
const isAcceptedHit = entry => entry.verdict === 'jewish' && !isFalseHit(entry);
function entrySourceKeys(entry){return [...new Set([...(Array.isArray(entry?.source_keys)?entry.source_keys:[]),entry?.source_key].filter(Boolean))];}
function sourceName(entry){const keys=entrySourceKeys(entry);return keys.length?keys.map(key=>knownSources.find(source=>source.key===key)?.label||key).join(' · '):'Unassigned source';}
const falseFilter = el('button', 'filter'); falseFilter.dataset.filter = 'false_hit'; falseFilter.append(document.createTextNode('False hits '), el('span', '', '0')); falseFilter.lastChild.id = 'falseFilterCount';
const confirmedFilter = el('button', 'filter'); confirmedFilter.dataset.filter = 'confirmed_hit'; confirmedFilter.append(document.createTextNode('Confirmed '), el('span', '', '0')); confirmedFilter.lastChild.id = 'confirmedFilterCount';
document.querySelector('[data-filter="no"]').after(falseFilter,confirmedFilter);
const feedbackPanel = el('section', 'feedback-panel'); feedbackPanel.id = 'feedbackPanel';
feedbackPanel.innerHTML = '<h3>Your classification</h3><p id="feedbackStatus" role="status"></p><div id="feedbackFields"><label for="feedbackReason">If this is false, why?</label><select id="feedbackReason"><option value="">Choose a false-hit reason…</option></select><label for="feedbackNote">Optional note · saved locally</label><textarea id="feedbackNote" rows="2" maxlength="1000" placeholder="What is actually visible?"></textarea><div class="feedback-actions"><button type="button" class="button primary" id="markConfirmed">Confirm hit</button><button type="button" class="button" id="markFalseHit">Mark false</button></div></div><button type="button" class="button" id="undoFeedback" hidden>Undo human label</button><p class="feedback-help">Confirmed and false labels are both saved with their evidence. Retrain uses every current label and automatically rebuilds the learned positive and negative entries in Classification rules. Model weights are not changed.</p>';
$('evidenceSummary').after(feedbackPanel);
let feedbackBusy = false, feedbackReasonsLoaded = false;
let matchCacheRoot='',currentMatch=null,currentMatchId=null,currentMatchHitIndex=0,matchLoadToken=0;
const matchDetails=new Map(),matchImagePromises=new Map();
const autoBackfillLine=document.createElement('label');autoBackfillLine.className='backfill-toggle';
const autoBackfillToggle=document.createElement('input');autoBackfillToggle.type='checkbox';autoBackfillToggle.id='autoBackfill';
autoBackfillLine.append(autoBackfillToggle,document.createTextNode(' Keep cards ready automatically while this app is open'));
document.querySelector('.prepare-controls').prepend(autoBackfillLine);
const backfillSummary=document.createElement('p');backfillSummary.id='backfillSummary';backfillSummary.className='backfill-summary';document.querySelector('.prepare-controls').append(backfillSummary);
const reviewBackfillSummary=document.createElement('p');reviewBackfillSummary.id='reviewBackfillSummary';reviewBackfillSummary.className='backfill-summary';document.querySelector('.configuration').append(reviewBackfillSummary);
for(const option of $('readyBuffer').options)option.textContent=`At least ${option.value} clip${option.value==='1'?'':'s'} ahead`;
const readyNote=$('readyMetric').nextElementSibling;
// Keep the dashboard in the window. Long data sets scroll in their own panels.
const reviewBody=document.createElement('div');reviewBody.className='review-body';
const reviewTables=document.createElement('div');reviewTables.className='review-tables';
const reviewMonitor=document.createElement('div');reviewMonitor.className='review-monitor';
reviewTables.append(document.querySelector('.results'),manualPanel);
reviewMonitor.append(document.querySelector('.worker-panel'),document.querySelector('.activity'));
reviewBody.append(reviewTables,reviewMonitor);$('reviewView').append(reviewBody);
const manualScroll=document.createElement('div');manualScroll.className='manual-table-scroll';manualScroll.append(manualTable);manualPanel.append(manualScroll);
const prepTop=document.createElement('div');prepTop.className='preparation-top';
document.querySelector('.source-card').before(prepTop);prepTop.append(document.querySelector('.source-card'),document.querySelector('.prepare-controls'));
const configNotes=document.createElement('div');configNotes.className='configuration-notes';configNotes.append($('modelWarning'),reviewBackfillSummary);document.querySelector('.configuration').append(configNotes);
const helpDialog=document.createElement('dialog');helpDialog.id='dashboardHelp';helpDialog.className='modal wide';helpDialog.innerHTML='<form method="dialog" class="modal-top"><h2>How review and preparation work</h2><button class="icon-button" aria-label="Close dashboard help">×</button></form>';
helpDialog.append($('workerHelp'),$('outputContractHelp'),document.querySelector('.pipeline-flow'));document.body.append(helpDialog);
const helpButton=document.createElement('button');helpButton.className='button subtle';helpButton.id='dashboardHelpButton';helpButton.textContent='Help';helpButton.onclick=()=>helpDialog.showModal();document.querySelector('#reviewView header .header-actions').prepend(helpButton);
const prepHelp=helpButton.cloneNode(true);prepHelp.id='preparationHelpButton';prepHelp.onclick=()=>helpDialog.showModal();document.querySelector('#preparationView header').append(prepHelp);
const workerDialog=document.createElement('dialog');workerDialog.id='workerDialog';workerDialog.className='modal compact';workerDialog.innerHTML='<form method="dialog" class="modal-top"><h2 id="workerDialogTitle">Worker</h2><button class="icon-button" aria-label="Close worker details">×</button></form><p id="workerDialogDetail"></p>';document.body.append(workerDialog);
let selectedWorker=null;
for(const notice of [$('rateLimitNotice'),recoveryNotice]){
 notice.tabIndex=0;notice.setAttribute('role','button');notice.setAttribute('aria-label','Open full recovery notice');
 const open=()=>{selectedWorker=null;$('workerDialogTitle').textContent='Recovery details';$('workerDialogDetail').textContent=notice.textContent;workerDialog.showModal();};
 notice.onclick=open;notice.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}};
}
$('detail').parentElement.title='Split large contact sheets into overlapping detailed image regions. Every region must be reviewed before a no verdict.';
function renderBackfill(){
 const b=preparation.backlog||{},auto=!!prefs.autoBackfill;
 $('autoBackfill').checked=auto;
 const running=['running','buffered'].includes(preparation.status);
 const status=preparation.status==='error'?`Stopped: ${preparation.message}`:running?preparation.status==='buffered'?'Reserve full · refills automatically':'Preparing more cards':auto?(preparation.counts?.pending?'Automatic backfill enabled':'End of pending URL queue'):'Automatic backfill paused';
 const summary=`${b.ahead_reels||0} / ${b.target||Number($('readyBuffer').value)||3} distinct clips ahead · ${(b.ahead_cards||0).toLocaleString()} cards · ${(b.ahead_frames||0).toLocaleString()} frames. ${status}.`;
 backfillSummary.textContent=summary;reviewBackfillSummary.textContent=`${b.ahead_reels||0}/${b.target||3} clips ahead · ${b.ahead_cards||0} cards · ${b.ahead_frames||0} frames · ${preparation.status==='error'?'preparation error':auto?'auto':'paused'}`;reviewBackfillSummary.title=summary;
 readyNote.textContent=`Distinct clips · ${preparation.counts?.ready||0} video IDs; shared IDs count once`;
}
let cueLabels = { orthodox_religious_dress: 'Orthodox religious dress', orthodox_beard_hat: 'Orthodox beard · hat', shtreimel: 'Shtreimel', payot: 'Payot', kippah_religious_setting: 'Kippah / yarmulke', tallit_tefillin: 'Tallit / tefillin', synagogue_ark_bimah: 'Synagogue / ark / bimah', jewish_cemetery_hebrew: 'Jewish cemetery / Hebrew', star_of_david_subject: 'Star of David', hebrew_religious_communal_text: 'Hebrew communal text', yellow_judenstern: 'Yellow Judenstern', jude_shop_marking: 'Jude shop marking', judaica: 'Judaica', jewish_ritual_ceremony: 'Jewish ritual / ceremony' };
const prettyCue = cue => cueLabels[cue] || String(cue || '').replaceAll('_', ' ');
function el(tag, className, text) { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; }
const paging = el('div','pagination'), pagingLabel = el('span'), previousPage = el('button','button subtle','← Previous'), nextPage = el('button','button subtle','Next →');
paging.append(pagingLabel,previousPage,nextPage);document.querySelector('.results').append(paging);paging.hidden=true;
previousPage.onclick=()=>{resultPage--;renderResults();};nextPage.onclick=()=>{resultPage++;renderResults();};
function toast(message, error = false) { $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, error ? 12000 : 6000); }
function act(fn) { return async (...args) => { try { return await fn(...args); } catch (e) { toast(e.message, true); } }; }
function setConnection(c) { connected = c.configured; $('connectionDot').classList.toggle('connected', connected); $('connectionLabel').textContent = connected ? 'OpenRouter key configured' : 'OpenRouter not connected'; $('connectBtn').textContent = connected ? 'Manage connection' : 'Connect'; $('keyStatus').textContent = c.remembered ? 'Your key is encrypted for this Windows account.' : c.environment ? 'Using OPENROUTER_API_KEY from the environment.' : 'Without Remember, the key is used for this session only.'; $('rememberKey').checked = c.remembered; controls(); window.renderRecheck?.(); }
function renderScrapfly(value={configured:false,remembered:false,environment:false}) {
  prefs.scrapfly=value;
  $('scrapflyStatus').textContent=value.remembered?'Scrapfly key is encrypted for this Windows account.':value.environment?'Using SCRAPFLY_API_KEY from the environment.':value.configured?'Scrapfly is configured for this session.':'No Scrapfly key configured.';
  $('rememberScrapflyKey').checked=!!value.remembered;
}
function renderVimeoAccess(value={mode:'none',configured:false}) {
  prefs.vimeoAccess=value;
  const mode=value.mode==='browser'?value.browser:value.mode;
  $('vimeoAccessMode').value=mode||'none';
  $('vimeoProfile').value=value.profile||'';
  $('vimeoProfile').closest('label').hidden=!['edge','chrome'].includes(mode);
  $('chooseVimeoCookies').hidden=mode!=='cookies-file';
  $('vimeoAccessStatus').textContent=value.mode==='cookies-file'?`Cookies file: ${value.fileName}`:value.mode==='browser'?`Uses ${value.browser==='edge'?'Microsoft Edge':'Google Chrome'}${value.profile?` · ${value.profile}`:''}.`:'No Vimeo sign-in configured.';
}
function controls() {
  const running = !!state.busy || ['starting', 'running', 'pausing'].includes(state.status) || !!window.filterPreviewBusy || !!window.recheckBusy;
  const learning = !!window.learningBusy;
  for (const id of ['chooseFolder','emptyChoose','refreshProject','refreshModels','primaryModel','verification','detail','budget','workers','videoConcurrency','dispatchMode','saveKey','forgetKey']) $(id).disabled = running;
  $('detail').disabled=running;
  $('refreshProject').disabled = running || !project;
  $('openFolder').disabled = !project;
  $('refreshModels').disabled = running || modelsLoading;
  $('primaryModel').disabled = running || modelsLoading || !models.length;
  $('secondaryModel').disabled = running || modelsLoading || !$('verification').checked || !models.length;
  $('verificationMode').disabled = running || !$('verification').checked;
  verificationModeLabel.hidden = !$('verification').checked;
  const preparing = ['running','buffered','pausing','crawling'].includes(preparation.status);
  const canSupply = preparing || (prefs.autoBackfill && (preparation.counts?.pending || preparation.counts?.resolving || preparation.counts?.downloading || preparation.counts?.extracting));
  const validSelection = models.some(m => m.id === $('primaryModel').value) && (!$('verification').checked || (models.some(m => m.id === $('secondaryModel').value) && $('secondaryModel').value !== $('primaryModel').value));
  $('startBtn').disabled = running || learning || modelsLoading || !connected || !project || (!project.videoCount && !canSupply) || !validSelection || (!canSupply && state.done >= state.total);
  $('autoBackfill').disabled = !project || preparation.status==='pausing';
  $('pauseBtn').disabled = !running || state.status === 'pausing';
  $('startBtn').textContent = ['paused','error','attention'].includes(state.status) ? '▶ Resume review' : '▶ Start review';
  $('exportBtn').disabled = !entries.length;
  for(const id of ['createWorkspace','importDetected','browseSource','addWebsiteSource','sourceWebsite','crawlUrl','crawlPermission','activeSource','reviewSource','sampleFps','frameWidth','readyBuffer','storageLimit','retryPreparation']) $(id).disabled = preparing || running || learning;
  $('crawlWebsite').disabled = preparing || running || learning || ($('sourceWebsite').value==='myfootage'&&!$('crawlPermission').checked);
  $('startPreparation').disabled = preparing || !project || !preparation.counts?.pending;
  $('pausePreparation').disabled = !preparing || preparation.status==='pausing';
  $('syncVerdicts').disabled = !project;
  $('cleanupMedia').disabled = !project;
  $('chooseFolder').disabled = running || preparing;
  if(learning)for(const id of ['chooseFolder','emptyChoose','refreshProject','refreshModels','primaryModel','secondaryModel','verification','detail','budget','workers','videoConcurrency','dispatchMode','saveKey','forgetKey','createWorkspace'])$(id).disabled=true;
  // An active run uses its compiled policy snapshot, so edits can be saved for
  // the next run without interrupting review or retraining.
  for (const id of ['saveCriteria','resetCriteria','addHitCriterion','addExclusion']) if ($(id)) $(id).disabled = false;
}
function renderState(s) {
  const deferredChanged=Object.prototype.hasOwnProperty.call(s,'deferred');
  state = {...state,...s,deferred:deferredChanged?s.deferred:(state.deferred||[])};
  s=state;
  $('videosMetric').replaceChildren(document.createTextNode(project ? `${s.done || 0} ` : '— '), el('em', '', project ? `/ ${s.total || 0}` : '/ —'));
  $('videosNote').textContent = project ? `${Math.max(0,(s.total || 0)-(s.done || 0))} video IDs remaining` : 'Choose a project folder';
  $('hitsMetric').textContent = entries.filter(isAcceptedHit).length;
  $('cardsMetric').textContent = s.cardsReviewed || 0;
  $('cardsNote').textContent = `${(s.regionsReviewed || 0).toLocaleString()} image regions saved · usually 6 per card`;
  $('spendMetric').textContent = `${s.estimated ? '~' : ''}$${(s.spend || 0).toFixed(s.spend > 0 && s.spend < .01 ? 4 : 2)}`;
  $('spendNote').textContent = `${s.attempts || 0} attempts · ${s.failedRequests || 0} failed${s.estimated ? ' · estimated cost' : ''}`;
  $('totalSpendMetric').textContent = `${s.totalEstimated ? '~' : ''}$${(s.totalSpend || 0).toFixed(s.totalSpend > 0 && s.totalSpend < .01 ? 4 : 2)}`;
  $('totalSpendNote').textContent = `This workspace · all sessions${s.totalEstimated ? ' · includes estimates' : ''}${s.unknownCostAttempts ? ` · ${s.unknownCostAttempts} attempt(s) with unknown cost` : ''}${s.costLogSkipped ? ' · some older log entries unreadable' : ''}`;
  $('totalSpendMetric').title = 'Recorded review and false-hit learning costs, including retries and unfinished work. Other workspaces and unreported provider charges are not included.';
  renderAverageCost();
  renderSpeed();
  const pct = s.total ? Math.min(100, Math.round((s.done || 0) / s.total * 100)) : 0;
  $('progressFill').style.width = pct + '%'; $('progressPercent').textContent = pct + '%'; document.querySelector('#reviewView .progress-track').setAttribute('aria-valuenow', pct);
  $('statusLabel').className = `live-label ${s.status || ''}`; $('statusLabel').replaceChildren(el('i'), document.createTextNode((s.status === 'idle' ? 'READY' : s.status || 'READY').toUpperCase()));
  $('progressMessage').textContent = s.message || 'Choose a project to get started';
  const deferred = (s.deferred || []).filter(v => !v.manual);
  if(deferredChanged)renderManualReview((s.deferred || []).filter(v => v.manual));
  recoveryNotice.hidden = !deferred.length;
  const nextRetry = Math.min(...deferred.map(v => v.next_retry_at || Date.now()));
  recoveryNotice.textContent = deferred.length ? `${deferred.length} video(s) waiting for ${deferred.some(v=>v.recovery_kind==='provider')?'provider or file':'file'} recovery: ${deferred.slice(0,5).map(v => v.id).join(', ')}${deferred.length > 5 ? ', …' : ''}. ${s.status === 'running' ? `Other ready videos continue; next check in ${Math.max(0,Math.ceil((nextRetry-Date.now())/1000))}s.` : 'Resume review to retry automatically.'} No verdict is saved for incomplete coverage. Details are in Open logs.` : '';

  const c = s.current;
  const completedForCurrent=c?.cardsTotal?Math.min(s.completedCardsCurrent||0,c.cardsTotal):s.completedCardsCurrent||0;
  $('currentDetail').textContent = c?.card ? `${c.id} · ${s.regionsReviewedCurrent || 0} image regions saved · ${completedForCurrent} / ${c.cardsTotal} cards complete · latest: ${c.card}, region ${c.region}` : 'Progress is saved as you review.';
  for(const node of document.querySelectorAll('.metric small,#currentDetail,#progressMessage'))node.title=node.textContent;
  renderWorkers();
  $('disagreementCount').textContent = s.disagreements ? `${s.disagreements} uncorroborated regions` : '';
  if (s.events?.length) $('activityList').replaceChildren(...s.events.slice(0, 15).map(ev => { const row = el('div', `activity-event ${ev.kind}`); row.append(el('time', '', new Date(ev.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'})), el('span', '', ev.message)); return row; }));
  controls();
}
function renderManualReview(items) {
  manualPanel.hidden = !items.length;
  manualTitle.textContent = `Needs manual review · ${items.length}`;
  manualNote.textContent = items.some(i=>i.recovery_kind==='source_changed')?'Source or provider needs attention · progress kept · no automatic retry':'Provider declined · progress kept · no automatic resend';
  manualNote.title = 'Saved progress and source files are retained while other videos continue. These are not verdicts, and Resume will not automatically retry them.';
  manualBody.replaceChildren(...items.map(item => {
    const row = el('tr'), id = el('td'), source = el('td'), reason = el('td'), action = el('td');
    id.append(el('strong','',item.id)); if(item.title)id.append(el('small','row-title',item.title));
    source.textContent = item.card ? `${item.card}${item.region ? ` · region ${item.region}` : ''}` : 'See saved review logs';
    reason.append(el('strong','',item.provider || (item.recovery_kind==='source_changed'?'Source validation':'Model provider')),el('small','',item.provider_message || item.message));
    if(item.provider_code)reason.append(el('small','',item.provider_code));
    if(item.card) {
      const preview = el('button','button subtle','View saved card');
      preview.onclick = act(async()=>{
        const image = await api.call('image',item.card_path||`frames/${item.copied_from || item.id}/cards/${item.card}`);
        $('preparedTitle').textContent = `${item.id} · needs manual review`;
        $('preparedInfo').textContent = `${item.card} · ${item.provider_message || item.message} · no verdict recorded`;
        $('preparedImage').src = image.data; preparedZoom.reset(); $('preparedDialog').showModal();
      }); action.append(preview);
    }
    for(const cell of [id,source,reason])cell.title=cell.textContent;
    row.append(id,source,reason,action);return row;
  }));
}
function renderWorkers() {
  const running = ['starting','running','pausing'].includes(state.status);
  const count = running ? state.workers || 1 : Number($('workers').value);
  const active = state.active || [];
  const videoLimit = running ? state.videoConcurrency || 1 : Number($('videoConcurrency').value);
  const concurrent = (running ? state.dispatchMode : $('dispatchMode').value) === 'concurrent';
  const limit = concurrent ? count : 1;
  $('workerHelp').textContent = concurrent ? 'Up to ' + count + ' image requests TOTAL across up to ' + videoLimit + ' videos. Workers share capacity fairly. A hit stops only that video’s new requests; other videos continue. Rate limits pause new requests globally.' : 'Up to ' + videoLimit + ' videos share one request at a time, with a 0.5-second pause after each response. A hit stops only its video’s remaining work.';
  $('workerStatus').textContent = running ? active.length + '/' + limit + ' requests · ' + (state.videos || []).length + '/' + videoLimit + ' videos' : count + ' workers · up to ' + videoLimit + ' videos';
  $('activeVideoList').replaceChildren(...(state.videos || []).map(v => {
    const row = el('div', 'active-video-row');
    row.append(el('strong', '', v.id), el('span', '', (v.completedCards || 0) + '/' + (v.cardsTotal || 0) + ' cards · ' + (v.active || []).length + ' requests'));
    row.title = v.id + ' · ' + (v.title || '') + ' · ' + (v.regionsSaved || 0) + ' regions saved · ' + (v.current?.card || v.status || 'checking');
    return row;
  }));
  $('workerRate').textContent = `${state.requests || 0} replies · ${(state.formatRetries||0)+(state.retries||0)+(state.networkRetries||0)+(state.providerRetries||0)} retries`;
  $('workerRate').title = `${state.requests || 0} responses · ${state.formatRetries || 0} verdict retries · ${state.retries || 0} rate-limit retries · ${state.networkRetries || 0} connection retries · ${state.providerRetries||0} provider retries`;
  renderRateLimit();
  const workerList=$('workerList');
  if(workerList.children.length!==count)workerList.replaceChildren(...Array.from({length:count}, (_,i) => {
    const tile = el('button','worker-tile');tile.type='button';
    tile.append(el('strong','',String(i+1)));tile.onclick=()=>{selectedWorker=i+1;renderWorkerDetail();workerDialog.showModal();};
    return tile;
  }));
  for(let i=0;i<count;i++){
    const task = active.find(a => a.worker === i + 1),tile=workerList.children[i];
    tile.className=`worker-tile${task ? ' busy' : ''}`;
    const detail=task ? `${task.id || ''} · ${task.card} · region ${task.region} · ${task.role==='secondary'?'Verify':'Review'} · ${task.model}` : running ? 'Waiting for work or cooldown' : 'Ready';
    tile.title=`Worker ${i+1} · ${detail}`;tile.setAttribute('aria-label',tile.title);
  }
  renderWorkerDetail();
}
function renderWorkerDetail(){
 if(selectedWorker===null)return;
 const task=(state.active||[]).find(a=>a.worker===selectedWorker);
 $('workerDialogTitle').textContent=`Worker ${selectedWorker} · ${task?'active':'waiting'}`;
 $('workerDialogDetail').textContent=task?`${task.id || ''} · ${task.role==='secondary'?'Verification':'Review'}: ${task.card}, region ${task.region}. Model: ${task.model}.`:'No image request is currently active on this worker. The pool follows the selected request mode and any shared cooldown.';
}
function renderRateLimit() {
  const r = state.rateLimit, running = state.status === 'running';
  const seconds = Math.max(0, Math.ceil(((r?.until || 0) - Date.now()) / 1000));
  $('rateLimitNotice').hidden = !running || (!seconds && !r?.spacingMs);
  if (!running || !r) return;
  if(seconds && r.reason==='provider'){
    $('rateLimitNotice').textContent=`Provider response incomplete · retrying the same image in ${seconds}s. New requests wait; saved regions are retained. Pause remains available.`;
    return;
  }
  if (seconds && r.reason === 'connection') {
    $('rateLimitNotice').textContent = `Connection interrupted · retrying the affected image in ${seconds}s. New requests wait; completed reviews stay saved. Pause remains available.`;
    return;
  }
  $('rateLimitNotice').textContent = seconds
    ? r.mode === 'concurrent' ? `Provider rate limit · shared cooldown for ${seconds}s. Requests already in flight can finish; new requests and retries wait. Then up to ${r.effectiveWorkers} workers resume. Pause remains available.` : `Provider rate limit · retrying this same image in ${seconds}s. Other workers are blocked until it succeeds. Pause remains available.`
    : `One request at a time. The next worker waits for a valid saved result and a ${r.spacingMs / 1000}s pause after the response.`;
}
function renderAverageCost() {
  const completed = new Set(entries.filter(e => ['jewish','no','filtered_no'].includes(e.verdict) && e.id != null && String(e.id).trim()).map(e => String(e.id))).size;
  const total = state.totalSpend;
  const average = project && completed > 0 && Number.isFinite(total) && total >= 0 ? total / completed : null;
  $('averageCostMetric').textContent = average === null ? '—' : `${state.totalEstimated ? '~' : ''}$${average.toFixed(average > 0 && average < .0001 ? 6 : 4)}`;
  $('averageCostNote').textContent = !project ? 'Choose a project folder' : !completed ? 'Available after the first completed video' : `${completed.toLocaleString()} completed video IDs · all sessions${state.totalEstimated ? ' · includes estimates' : ''}${state.unknownCostAttempts ? ' · some charges unknown' : ''}${state.costLogSkipped ? ' · incomplete older logs' : ''}`;
  $('averageCostMetric').title = 'Recorded total workspace spend ÷ completed video IDs (both hits and no hits, including reused and existing verdicts). Includes billed retries and unfinished work; excludes unknown charges. This is the cumulative workspace average, not the price of the current video.';
}
function renderSpeed() {
  const ms = (state.processingMs || 0) + (state.processingActive ? Math.max(0, Date.now() - (state.metricsAt || Date.now())) : 0);
  const videos = state.sessionVideos || 0, rate = ms > 0 ? videos * 60000 / ms : 0;
  $('speedMetric').textContent = rate.toFixed(rate > 0 && rate < .01 ? 3 : 2);
  $('speedNote').textContent = `${videos} IDs completed · ${(ms / 60000).toFixed(1)} active min${state.sessionReused ? ` · ${state.sessionReused} reused` : ''}`;
  $('speedMetric').title = 'Session average: completed video IDs (including shared-reel copies) per active review minute. Paused and closed time excluded.';
}
setInterval(() => { renderRateLimit(); renderSpeed(); }, 1000);
$('workers').onchange = renderWorkers;
$('videoConcurrency').onchange = renderWorkers;
$('dispatchMode').onchange = act(async()=>{ const mode=$('dispatchMode').value; renderWorkers(); try { prefs.dispatchMode=await api.call('set-dispatch-mode',mode); } catch(e) { $('dispatchMode').value=prefs.dispatchMode||'one-at-a-time';renderWorkers();throw e; } });
function loadProject(p) {
  if (!p) return;
  if(matchCacheRoot!==p.root){matchCacheRoot=p.root;matchDetails.clear();matchImagePromises.clear();currentMatch=null;currentMatchId=null;} project = p; entries = p.entries || []; hitEntries = p.hitEntries || entries.filter(entry=>entry.verdict==='jewish');
  for(const [id,detail] of matchDetails){const summary=hitEntries.find(entry=>String(entry.id)===id)||entries.find(entry=>String(entry.id)===id);if(!summary||(summary.feedback_target&&summary.feedback_target!==detail.feedback_target)||(summary.human_review?.status||null)!==(detail.human_review?.status||null))matchDetails.delete(id);}
  $('folderName').textContent = p.root.split(/[\\/]/).filter(Boolean).at(-1); $('folderName').title = p.root;
  $('folderHint').textContent = `${p.videoCount.toLocaleString()} video IDs · ${p.cardCount.toLocaleString()} cards`;
  $('folderHint').title = p.root; $('activityNote').textContent = p.root;
  if (currentEvidence && $('evidenceDialog').open) renderFeedback();
  renderResults();renderMatchCount();window.renderBulkLabels?.();
  if(!$('matchesView').hidden){const list=acceptedMatches(),index=list.findIndex(entry=>String(entry.id)===String(currentMatchId));if(index<0)selectMatch(list[0]?.id);else renderMatchText(currentMatch||list[index],index,list.length);}
  renderState(state);window.renderRecheck?.();
}
function fillModels(savedPrimary, savedSecondary) {
  models = window.modelCapabilities.visionReviewers(models);
  const preferred = ['google/gemini-3.1-pro-preview','anthropic/claude-opus-5','openai/gpt-6-astra','qwen/qwen3-vl-235b-a22b-instruct'];
  const sorted = [...models].sort((a,b) => { const ai = preferred.indexOf(a.id), bi = preferred.indexOf(b.id); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.name.localeCompare(b.name); });
  for (const id of ['primaryModel','secondaryModel']) {
    const placeholder = el('option', '', sorted.length ? 'Choose a vision model…' : 'Vision model list unavailable'); placeholder.value = '';
    $(id).replaceChildren(placeholder, ...sorted.map(m => { const o = el('option', '', m.name); o.value = m.id; return o; }));
  }
  $('primaryModel').value = models.some(m=>m.id===savedPrimary) ? savedPrimary : '';
  $('secondaryModel').value = models.some(m=>m.id===savedSecondary) ? savedSecondary : '';
  prices(); controls();
}
function prices() {
  const primary = models.find(m=>m.id===$('primaryModel').value), secondary = models.find(m=>m.id===$('secondaryModel').value);
  const fmt = m => m ? `Image input ✓ · $${(Number(m.pricing.prompt || 0)*1e6).toLocaleString()} in / $${(Number(m.pricing.completion || 0)*1e6).toLocaleString()} out · per 1M tokens` : 'Choose a model with verified image input and text output.';
  $('primaryPrice').textContent = fmt(primary); $('secondaryPrice').textContent = $('verification').checked ? fmt(secondary) : 'Single-model mode: positives are not independently verified.';
}
async function refreshModels() {
  if (modelsLoading) return;
  const primary = $('primaryModel').value || prefs.primary, secondary = $('secondaryModel').value || prefs.secondary;
  modelsLoading = true; controls();
  try {
    const data = await api.call('get-models'); models = window.modelCapabilities.visionReviewers(data.models); fillModels(primary, secondary);
    const missing = (primary && !models.some(m=>m.id===primary)) || ($('verification').checked && secondary && !models.some(m=>m.id===secondary));
    $('modelWarning').hidden = false;
    $('modelWarning').textContent = `${models.length} vision review models · image input and text output. Generation models, routers and batch variants are excluded.` + (missing ? ' A previous selection is unavailable or incompatible. Choose another vision model.' : '') + (data.cached ? ' Using a capability-checked saved list; live verification is required before review. ' + data.error : '');
  }
  catch(e) { models = []; fillModels('', ''); $('modelWarning').hidden = false; $('modelWarning').textContent = 'Could not load verified vision models. Check your connection, then click ↻ beside Review model. ' + e.message; }
  finally { $('modelWarning').title=$('modelWarning').textContent; modelsLoading = false; controls(); }
}
function renderResults() {
  renderAverageCost();
  const counts = { jewish: entries.filter(isAcceptedHit).length, confirmed_hit: entries.filter(isConfirmedHit).length, false_hit: entries.filter(isFalseHit).length, no: entries.filter(e=>['no','filtered_no'].includes(e.verdict)).length, all: entries.length };
  $('falseFilterCount').textContent = counts.false_hit;
  $('confirmedFilterCount').textContent = counts.confirmed_hit;
  document.querySelector('#reviewView .results-heading p').textContent = `Click a result to inspect or label it${project?.feedback?.active ? ' · ' + project.feedback.active + ' human label' + (project.feedback.active===1?'':'s') : ''}.`;
  $('hitFilterCount').textContent = counts.jewish; $('allFilterCount').textContent = counts.all; $('noFilterCount').textContent = counts.no; $('hitsMetric').textContent = counts.jewish;
  const query = $('search').value.toLowerCase().trim();
  const list = entries.filter(e => (selectedFilter === 'all' || (selectedFilter === 'false_hit' ? isFalseHit(e) : selectedFilter === 'confirmed_hit' ? isConfirmedHit(e) : selectedFilter === 'jewish' ? isAcceptedHit(e) : (selectedFilter==='no'?['no','filtered_no'].includes(e.verdict):e.verdict === selectedFilter))) && (!query || `${e.id} ${e.title || ''} ${e.summary || ''} ${JSON.stringify(e.cues || '')} ${e.human_review?.note || ''}`.toLowerCase().includes(query))).slice().reverse();
  resultPage=Math.max(0,Math.min(resultPage,Math.ceil(list.length/100)-1));
  paging.hidden=list.length<=100;pagingLabel.textContent=`${resultPage*100+1}–${Math.min(list.length,(resultPage+1)*100)} of ${list.length.toLocaleString()} results`;previousPage.disabled=resultPage===0;nextPage.disabled=(resultPage+1)*100>=list.length;
  $('resultCount').textContent = list.length;
  $('resultsBody').replaceChildren(...list.slice(resultPage*100,(resultPage+1)*100).map(entry => {
    const row = el('tr','result-row'); row.tabIndex = 0; row.setAttribute('aria-label', `Inspect video ${entry.id}`);
    const id = el('td'); id.append(el('strong','',String(entry.id))); if (entry.title) id.append(el('small','row-title',entry.title)); if((entry.catalog_id_count||1)>1)id.append(el('small','',`${entry.catalog_id_count} catalog records share this evidence`));else if(entry.copied_from) id.append(el('small','',`Same reviewed clip · ${entry.copied_from}`));
    const cueValues = Array.isArray(entry.cues) ? entry.cues : entry.cues ? [entry.cues] : [];
    const cue = el('td','',cueValues.map(prettyCue).join(' / ') || '—');if((entry.evidence_hit_count||0)>1)cue.append(el('small','',`${entry.evidence_hit_count} saved hits`));
    const evidence = el('td'); evidence.append(el('div','evidence-excerpt',entry.summary || 'No description saved.'));
    const cards = el('td','',String(entry.cards_reviewed_count ?? (Array.isArray(entry.cards_reviewed) ? entry.cards_reviewed.length : entry.cards_reviewed ?? '—')));
    const verdict = el('td'); verdict.append(el('span', `pill ${isFalseHit(entry)?'false-hit':entry.verdict==='jewish'?'hit':''}`,isFalseHit(entry)?'FALSE HIT':entry.verdict==='jewish'?'STRICT HIT':entry.verdict==='filtered_no'?'NO HIT · FILTERED':entry.verdict==='no'?'NO HIT':String(entry.verdict).toUpperCase()));
    row.append(id,cue,evidence,cards,verdict,el('td','','↗'));
    const open=()=>isAcceptedHit(entry)?openMatchReview(entry.id):openEvidence(entry);
    row.addEventListener('click',act(open)); row.addEventListener('keydown',act(e=>{if(e.key==='Enter')return open();})); return row;
  }));
  $('emptyState').hidden = list.length > 0;
  if (!list.length) { $('emptyState').querySelector('h3').textContent = query ? 'No matching results' : counts.all && selectedFilter==='jewish' ? 'No strict hits recorded yet' : 'Your evidence trail starts here'; $('emptyState').querySelector('p').textContent = query ? 'Try another ID, title, or visible cue.' : counts.all ? 'Reviewed videos are saved. Select All reviewed to inspect the full result list.' : 'Choose a contact-sheet folder and a vision model. Confirmed hits will appear here with the exact image that supports them.'; }
  $('emptyChoose').hidden = !!project; controls();
}
function attachZoom({scroll,image,stage,zoomedClass,level,zoomIn,zoomOut,zoomFit,dialog,draggable=false}){
  let scale=0;
  let drag=null,suppressClick=false;
  const min=0.25,max=8;
  const fitScale=()=>{
    const nw=image.naturalWidth,nh=image.naturalHeight;
    if(!nw||!nh)return 1;
    const pad=32;
    return Math.min(1,(Math.max(scroll.clientWidth-pad,1))/nw,(Math.max(scroll.clientHeight-pad,1))/nh);
  };
  const firstIn=()=>fitScale()>=0.9?Math.min(max,2):1;
  const apply=(next,origin)=>{
    const prevW=image.offsetWidth,prevH=image.offsetHeight;
    scale=next;
    const active=scale>0;
    if(stage)stage.classList.toggle(zoomedClass,active);
    image.classList.toggle(zoomedClass,active);
    if(!active){image.style.width='';image.style.maxWidth='';image.style.height='';}
    else if(image.naturalWidth){image.style.maxWidth='none';image.style.width=`${Math.round(image.naturalWidth*scale)}px`;image.style.height='auto';}
    if(level)level.textContent=active?`${Math.round(scale*100)}%`:'Fit';
    if(origin&&prevW&&image.offsetWidth){
      const rect=scroll.getBoundingClientRect();
      const ox=origin.x-rect.left-scroll.clientLeft+scroll.scrollLeft;
      const oy=origin.y-rect.top-scroll.clientTop+scroll.scrollTop;
      scroll.scrollLeft=ox*(image.offsetWidth/prevW)-(origin.x-rect.left-scroll.clientLeft);
      scroll.scrollTop=oy*(image.offsetHeight/Math.max(prevH,1))-(origin.y-rect.top-scroll.clientTop);
    }
  };
  const zoomBy=(dir,origin)=>{
    if(!image.naturalWidth)return;
    if(scale===0&&dir>0)return apply(firstIn(),origin);
    if(scale>0&&dir<0&&scale<=1.01)return apply(0,origin);
    const current=scale||fitScale();
    let next=Math.round(current*(dir>0?1.25:0.8)*100)/100;
    next=Math.min(max,Math.max(min,next));
    if(dir<0&&next<=fitScale()+0.02)next=0;
    apply(next,origin);
  };
  image.addEventListener('click',e=>{if(suppressClick){suppressClick=false;return;}if(e.detail>1)return;apply(scale?0:firstIn(),{x:e.clientX,y:e.clientY});});
  if(draggable){
    image.draggable=false;
    image.addEventListener('pointerdown',e=>{
      if(!scale||e.button!==0)return;
      drag={x:e.clientX,y:e.clientY,left:scroll.scrollLeft,top:scroll.scrollTop,moved:false};
      image.setPointerCapture?.(e.pointerId);image.classList.add('panning');e.preventDefault();
    });
    image.addEventListener('pointermove',e=>{
      if(!drag)return;
      const dx=e.clientX-drag.x,dy=e.clientY-drag.y;
      if(Math.abs(dx)+Math.abs(dy)>4)drag.moved=true;
      scroll.scrollLeft=drag.left-dx;scroll.scrollTop=drag.top-dy;
    });
    const endDrag=e=>{
      if(!drag)return;
      suppressClick=drag.moved;drag=null;image.classList.remove('panning');
      if(image.hasPointerCapture?.(e.pointerId))image.releasePointerCapture(e.pointerId);
    };
    image.addEventListener('pointerup',endDrag);image.addEventListener('pointercancel',endDrag);
    image.addEventListener('dragstart',e=>e.preventDefault());
  }
  image.addEventListener('load',()=>apply(scale));
  scroll.addEventListener('wheel',e=>{
    if(!e.ctrlKey&&!e.metaKey)return;
    e.preventDefault();
    zoomBy(e.deltaY<0?1:-1,{x:e.clientX,y:e.clientY});
  },{passive:false});
  zoomIn.onclick=()=>zoomBy(1);
  zoomOut.onclick=()=>zoomBy(-1);
  zoomFit.onclick=()=>apply(0);
  dialog.addEventListener('keydown',e=>{
    if(e.target.closest('input,textarea,select'))return;
    if(e.key==='+'||e.key==='='){e.preventDefault();zoomBy(1);}
    else if(e.key==='-'||e.key==='_'){e.preventDefault();zoomBy(-1);}
    else if(e.key==='0'){e.preventDefault();apply(0);}
  });
  return {reset:()=>apply(0),apply,zoomBy};
}
const evidenceZoom=attachZoom({scroll:$('imageScroll'),image:$('evidenceImage'),stage:$('imageStage'),zoomedClass:'zoomed',level:$('zoomLevel'),zoomIn:$('zoomIn'),zoomOut:$('zoomOut'),zoomFit:$('zoomFit'),dialog:$('evidenceDialog')});
const preparedZoom=attachZoom({scroll:$('preparedScroll'),image:$('preparedImage'),stage:null,zoomedClass:'expanded',level:$('prepZoomLevel'),zoomIn:$('prepZoomIn'),zoomOut:$('prepZoomOut'),zoomFit:$('prepZoomFit'),dialog:$('preparedDialog')});
const matchZoom=attachZoom({scroll:$('matchImageScroll'),image:$('matchImage'),stage:$('matchImageStage'),zoomedClass:'zoomed',level:$('matchZoomLevel'),zoomIn:$('matchZoomIn'),zoomOut:$('matchZoomOut'),zoomFit:$('matchZoomFit'),dialog:$('matchesView'),draggable:true});
const acceptedMatches=()=>hitEntries.filter(isAcceptedHit).slice().reverse();
const matchEvidenceHits=entry=>Array.isArray(entry?.evidence_hits)&&entry.evidence_hits.length?entry.evidence_hits:entry?.evidence?[entry.evidence]:[];
const selectedMatchEvidence=entry=>matchEvidenceHits(entry)[Math.max(0,Math.min(currentMatchHitIndex,matchEvidenceHits(entry).length-1))]||entry?.evidence||null;
const matchRelative=entry=>entry?.human_review?.evidence_image||selectedMatchEvidence(entry)?.card_path||null;
function trimCache(cache,limit){while(cache.size>limit)cache.delete(cache.keys().next().value);}
function withSummaryContext(detail,summary){
  if(!summary)return detail;
  return {...detail,source_key:detail.source_key||summary.source_key||null,source_keys:summary.source_keys||entrySourceKeys(detail),source_count:summary.source_count??entrySourceKeys(detail).length,catalog_ids:summary.catalog_ids||detail.catalog_ids,catalog_id_count:summary.catalog_id_count??detail.catalog_id_count};
}
function getResultDetail(value){
  const id=String(value?.id??value),summary=hitEntries.find(e=>String(e.id)===id)||entries.find(e=>String(e.id)===id);
  if(value?.evidence)return Promise.resolve(withSummaryContext(value,summary));
  const saved=matchDetails.get(id);
  if(saved&&(!summary?.feedback_target||saved.feedback_target===summary.feedback_target)){const contextual=withSummaryContext(saved,summary);matchDetails.delete(id);matchDetails.set(id,contextual);return Promise.resolve(contextual);}
  const pending=api.call('result-detail',id).then(detail=>{detail=withSummaryContext(detail,summary);matchDetails.set(id,detail);trimCache(matchDetails,20);return detail;});
  return pending;
}
function getMatchImage(relative,full=false){
  if(full)return api.call('match-image',{relative,full:true,maxWidth:1600,maxHeight:1050});
  const key=`${relative}|${full?'full':'preview'}`;
  if(matchImagePromises.has(key)){const saved=matchImagePromises.get(key);matchImagePromises.delete(key);matchImagePromises.set(key,saved);return saved;}
  const pending=api.call('match-image',{relative,full,maxWidth:1600,maxHeight:1050}).catch(error=>{matchImagePromises.delete(key);throw error;});
  matchImagePromises.set(key,pending);trimCache(matchImagePromises,20);return pending;
}
function renderMatchCount(){const count=acceptedMatches().length;$('matchesNavCount').textContent=count.toLocaleString();$('matchesNav').title=`${count.toLocaleString()} accepted strict matches`;}
function renderMatchText(entry,index,total){
  currentMatch=entry;currentMatchId=String(entry.id);
  $('matchPosition').textContent=`${index+1} of ${total}`;$('matchId').textContent=String(entry.id);
  $('matchTitle').textContent=entry.title||String(entry.id);
  const hits=matchEvidenceHits(entry);currentMatchHitIndex=Math.max(0,Math.min(currentMatchHitIndex,Math.max(0,hits.length-1)));const evidence=selectedMatchEvidence(entry);
  const cues=[...new Set([evidence?.primary?.cue,evidence?.secondary?.cue].filter(Boolean))];
  $('matchCue').textContent=(cues.length?cues:(Array.isArray(entry.cues)?entry.cues:entry.cues?[entry.cues]:[])).map(prettyCue).join(' / ')||'Strict visual match';$('matchSummary').textContent=evidence?.primary?.evidence||entry.summary||'No evidence description was saved.';
  $('matchModelEvidence').replaceChildren(...[evidence?.primary,evidence?.secondary].filter(Boolean).map(result=>{const node=el('div','model-evidence');node.append(el('strong','',result.model||'Model review'),el('p','',result.evidence||''),el('p','',result.location?`Location: ${result.location}`:''));return node;}));
  const rows=[['Source',sourceName(entry)],['Video',entry.id],['Story range',entry.scope==='segment'?`${entry.segment_start}–${entry.segment_end} seconds`:'Whole reel / previous record'],['Card',evidence?.card||'—'],['Confidence',typeof entry.confidence==='number'?`${Math.round(entry.confidence*100)}% · subjective`:'Not calibrated'],['Reviewed',entry.reviewed_at?new Date(entry.reviewed_at).toLocaleString():'Previously saved'],...(evidence?.frame_map?[['Source frames',evidence.frame_map.map(frame=>`${Number(frame.timestamp).toFixed(2)}s`).join(', ')]]:[])];
  $('matchMetadata').replaceChildren(...rows.flatMap(([name,value])=>[el('dt','',name),el('dd','',String(value))]));
  const hasSource=/^https?:\/\//i.test(entry.url||'');$('matchSource').hidden=!hasSource;$('matchSourceTop').hidden=!hasSource;
  $('previousMatch').disabled=total<2;$('nextMatch').disabled=total<2;
  $('matchHitPosition').textContent=`Hit ${hits.length?currentMatchHitIndex+1:0} of ${hits.length}`;$('previousVideoHit').disabled=hits.length<2;$('nextVideoHit').disabled=hits.length<2;document.querySelector('.match-hit-nav').hidden=hits.length<2;
}
function displayMatchImage(image,entry){
  if(!entry||String(entry.id)!==String(currentMatchId))return;
  $('matchImage').src=image.data;$('matchImageStage').hidden=false;$('matchImageError').hidden=true;$('matchFullImage').hidden=image.full;
  const evidence=selectedMatchEvidence(entry);$('matchImageLabel').textContent=`${evidence?.card||'Evidence image'} · hit ${currentMatchHitIndex+1} of ${Math.max(1,matchEvidenceHits(entry).length)} · ${image.full?'full resolution':'fast preview'} · click / Ctrl+wheel to zoom · drag when zoomed`;
  const box=evidence?.bounds,size=image.originalSize||image.size;
  if(box&&size?.width&&size?.height){$('matchRegionBox').style.cssText=`left:${box.x/size.width*100}%;top:${box.y/size.height*100}%;width:${box.width/size.width*100}%;height:${box.height/size.height*100}%`;$('matchRegionBox').hidden=!$('matchShowRegion').checked;}else $('matchRegionBox').hidden=true;
  Promise.resolve($('matchImage').decode?.()).catch(()=>{}).finally(()=>matchZoom.reset());
}
function prefetchMatch(summary){
  if(!summary)return;
  getResultDetail(summary).then(detail=>{const relative=matchRelative(detail);return relative?getMatchImage(relative,false):null;}).catch(()=>{});
}
async function selectMatch(id){
  const list=acceptedMatches();renderMatchCount();
  $('matchesEmpty').hidden=!!list.length;$('matchReview').hidden=!list.length;
  if(!list.length){currentMatch=null;currentMatchId=null;return;}
  let index=list.findIndex(entry=>String(entry.id)===String(id));if(index<0)index=0;
  const summary=list[index],token=++matchLoadToken;currentMatchId=String(summary.id);currentMatchHitIndex=0;renderMatchText(summary,index,list.length);
  $('matchImage').removeAttribute('src');$('matchImageStage').hidden=true;$('matchImageError').hidden=false;$('matchImageError').textContent='Loading this match…';$('matchFullImage').hidden=true;matchZoom.reset();
  try{
    const detail=await getResultDetail(summary);if(token!==matchLoadToken)return;
    renderMatchText(detail,index,list.length);
    const relative=matchRelative(detail);
    if(!relative){$('matchImageError').textContent='This match has no saved evidence image.';return;}
    const image=await getMatchImage(relative,false);if(token!==matchLoadToken)return;displayMatchImage(image,detail);
    prefetchMatch(list[(index-1+list.length)%list.length]);prefetchMatch(list[(index+1)%list.length]);
  }catch(error){if(token===matchLoadToken)$('matchImageError').textContent=error.message;}
}
function moveMatch(delta){const list=acceptedMatches();if(!list.length)return;let index=list.findIndex(entry=>String(entry.id)===String(currentMatchId));if(index<0)index=0;selectMatch(list[(index+delta+list.length)%list.length].id);}
async function showCurrentVideoHit(){
 const entry=currentMatch;if(!entry)return;const token=++matchLoadToken,index=acceptedMatches().findIndex(value=>String(value.id)===String(entry.id));renderMatchText(entry,Math.max(0,index),acceptedMatches().length);
 $('matchImage').removeAttribute('src');$('matchImageStage').hidden=true;$('matchImageError').hidden=false;$('matchImageError').textContent='Loading this hit…';$('matchFullImage').hidden=true;matchZoom.reset();
 const relative=matchRelative(entry);if(!relative){$('matchImageError').textContent='This hit has no saved evidence image.';return;}try{const image=await getMatchImage(relative,false);if(token!==matchLoadToken)return;displayMatchImage(image,entry);}catch(error){if(token===matchLoadToken)$('matchImageError').textContent=error.message;}
}
function moveVideoHit(delta){const hits=matchEvidenceHits(currentMatch);if(hits.length<2)return;currentMatchHitIndex=(currentMatchHitIndex+delta+hits.length)%hits.length;showCurrentVideoHit();}
function openMatchReview(id){showView('matches');return selectMatch(id);}
$('previousMatch').onclick=()=>moveMatch(-1);$('nextMatch').onclick=()=>moveMatch(1);
$('previousVideoHit').onclick=()=>moveVideoHit(-1);$('nextVideoHit').onclick=()=>moveVideoHit(1);
$('matchesBack').onclick=$('matchesEmptyBack').onclick=()=>showView('review');
$('matchSource').onclick=$('matchSourceTop').onclick=act(()=>currentMatch&&api.call('open-url',currentMatch.url));
$('matchInspect').onclick=act(()=>currentMatch&&openEvidence({...currentMatch,evidence:selectedMatchEvidence(currentMatch),summary:selectedMatchEvidence(currentMatch)?.primary?.evidence||currentMatch.summary,cues:[...new Set([selectedMatchEvidence(currentMatch)?.primary?.cue,selectedMatchEvidence(currentMatch)?.secondary?.cue].filter(Boolean))]}));
$('matchShowRegion').onchange=()=>{$('matchRegionBox').hidden=!$('matchShowRegion').checked||!selectedMatchEvidence(currentMatch)?.bounds;};
$('matchFullImage').onclick=act(async()=>{const entry=currentMatch,relative=matchRelative(entry);if(!entry||!relative)return;$('matchFullImage').disabled=true;try{displayMatchImage(await getMatchImage(relative,true),entry);}finally{$('matchFullImage').disabled=false;}});
document.addEventListener('keydown',event=>{if($('matchesView').hidden||event.target.closest('input,textarea,select,dialog'))return;if(event.key==='ArrowLeft'&&event.shiftKey){event.preventDefault();moveVideoHit(-1);}else if(event.key==='ArrowRight'&&event.shiftKey){event.preventDefault();moveVideoHit(1);}else if(event.key==='ArrowLeft'){event.preventDefault();moveMatch(-1);}else if(event.key==='ArrowRight'){event.preventDefault();moveMatch(1);}});
async function openEvidence(entry) {
  const requested=entry;currentEvidence=requested;
  $('evidenceTitle').textContent=`${entry.id}${entry.title?' · '+entry.title:''}`;$('evidenceImage').removeAttribute('src');$('imageStage').hidden=true;$('imageError').hidden=false;$('imageError').textContent='Loading the saved result…';$('regionBox').hidden=true;evidenceZoom.reset();if(!$('evidenceDialog').open)$('evidenceDialog').showModal();
  entry=await getResultDetail(entry);if(currentEvidence!==requested)return;currentEvidence=entry;const evidence = entry.evidence;
  $('evidenceTitle').textContent = `${entry.id}${entry.title ? ' · '+entry.title : ''}`;
  $('evidenceBadge').className = `pill ${entry.verdict==='jewish'?'hit':''}`; $('evidenceBadge').textContent = entry.verdict==='jewish'?'STRICT HIT':entry.verdict==='filtered_no'?'NO CONFIRMED HIT — FILTERED REVIEW':'NO HIT';
  const cues = Array.isArray(entry.cues) ? entry.cues : entry.cues ? [entry.cues] : [];
  $('evidenceCue').textContent = cues.map(prettyCue).join(' / ') || 'No strict visible cue'; $('evidenceSummary').textContent = entry.summary || '';
  $('feedbackNote').value = ''; $('feedbackReason').value = '';
  renderFeedback();
  if (!feedbackReasonsLoaded) {
    const reasons = await api.call('feedback-reasons');
    $('feedbackReason').append(...reasons.map(reason => { const option = el('option', '', reason.label); option.value = reason.id; return option; }));
    feedbackReasonsLoaded = true;
    renderFeedback();
  }
  $('modelEvidence').replaceChildren(...[evidence?.primary,evidence?.secondary].filter(Boolean).map(r=>{const d=el('div','model-evidence');d.append(el('strong','',r.model || 'Model review'),el('p','',r.evidence),el('p','',`Location: ${r.location}`));return d;}));
  const rows = [['Source',sourceName(entry)],['Story range',entry.scope==='segment' ? entry.segment_start+'–'+entry.segment_end+' seconds in the source reel' : 'Whole reel / previous record'],['Method',entry.method || 'Previous review'],['Card',evidence?.card || '—'],['Region',evidence?.region || '—'],['Confidence',entry.confidence == null ? 'Not calibrated' : typeof entry.confidence==='number' ? `${Math.round(entry.confidence*100)}% · subjective` : String(entry.confidence)],['Reviewed',entry.reviewed_at ? new Date(entry.reviewed_at).toLocaleString() : 'Previously saved'],['Copied from',entry.copied_from || '—'],...(entry.filter?[['Frames screened',entry.filter.frames_screened],['Frames selected',entry.filter.frames_selected],['Frames AI reviewed',entry.filter.frames_reviewed],['Filter validation',entry.filter.validation]]:[]),...(evidence?.frame_map?[['Source frame times',evidence.frame_map.map(f=>f.timestamp.toFixed(2)+'s').join(', ')]]:[])];
  $('evidenceMetadata').replaceChildren(...rows.flatMap(([a,b])=>[el('dt','',a),el('dd','',String(b))]));
  $('sourceLink').hidden = !/^https?:\/\//i.test(entry.url || '');
  $('evidenceImage').removeAttribute('src'); $('imageStage').hidden = true; $('imageStage').classList.remove('zoomed'); evidenceZoom.reset(); $('imageError').hidden = false; $('imageError').textContent = 'Loading the source image…'; $('regionBox').hidden = true;
  if(!$('evidenceDialog').open)$('evidenceDialog').showModal();
  const relative = entry.human_review?.evidence_image || evidence?.card_path || (entry.filter ? null : (Array.isArray(entry.cards_reviewed) && entry.cards_reviewed.length ? `frames/${entry.copied_from || entry.id}/cards/${entry.cards_reviewed[0]}` : null));
  if (!relative) { $('imageError').textContent = entry.filter?'Generated images may have been cleaned after the completed filtered review. The screening log, frame timestamps, scores, and AI review records remain saved.':'This saved verdict has no evidence-image path. The original verdict is preserved.'; return; }
  try {
    const image = await api.call('image',relative);
    if(currentEvidence!==entry)return;
    $('evidenceImage').src=image.data;$('imageStage').hidden=false;$('imageError').hidden=true;$('imageLabel').textContent=`${evidence?.card || 'Contact sheet'} · + / click / Ctrl+wheel to zoom in`;
    const b=evidence?.bounds;if(b){$('regionBox').style.cssText=`left:${b.x/image.size.width*100}%;top:${b.y/image.size.height*100}%;width:${b.width/image.size.width*100}%;height:${b.height/image.size.height*100}%`;$('regionBox').hidden=!$('showRegion').checked;}
    Promise.resolve($('evidenceImage').decode?.()).catch(()=>{}).finally(()=>evidenceZoom.reset());
  }catch(e){$('imageError').textContent=e.message;}
}
function renderFeedback() {
  const entry = currentEvidence; if (!entry) return;
  const flagged = isFalseHit(entry), confirmed = isConfirmedHit(entry), labeled = flagged || confirmed, correction = entry.human_review;
  feedbackPanel.hidden = entry.verdict !== 'jewish';
  $('feedbackFields').hidden = labeled; $('undoFeedback').hidden = !labeled;
  $('markConfirmed').disabled = feedbackBusy;
  $('markFalseHit').disabled = feedbackBusy || !$('feedbackReason').value;
  $('undoFeedback').disabled = feedbackBusy;
  $('feedbackReason').disabled = feedbackBusy; $('feedbackNote').disabled = feedbackBusy;
  $('evidenceBadge').className = `pill ${flagged ? 'false-hit' : confirmed ? 'confirmed-hit' : entry.verdict === 'jewish' ? 'hit' : ''}`;
  $('evidenceBadge').textContent = flagged ? 'FALSE HIT · HUMAN LABEL' : confirmed ? 'CONFIRMED HIT · HUMAN LABEL' : entry.verdict === 'jewish' ? 'STRICT HIT' : entry.verdict==='filtered_no'?'NO CONFIRMED HIT — FILTERED REVIEW':'NO HIT';
  $('feedbackStatus').textContent = flagged ? `Excluded from hits and exports. Original verdict and saved evidence card retained; downloaded video is not retained. Unreviewed cards were not rechecked.${correction.flagged_id !== String(entry.id) ? ' This label also applies to the identical copied evidence.' : ''} Reason: ${[...$('feedbackReason').options].find(o => o.value === correction.reason)?.textContent || correction.reason}.${correction.note ? ' Your note: ' + correction.note : ''}${correction.evidence_status !== 'saved' ? ' The original evidence image was unavailable when labeled.' : ''}` : confirmed ? `Saved as a confirmed positive and kept in hits and exports.${correction.flagged_id !== String(entry.id) ? ' This label also applies to the identical copied evidence.' : ''}${correction.note ? ' Your note: ' + correction.note : ''}${correction.evidence_status !== 'saved' ? ' The original evidence image was unavailable when labeled.' : ''}` : 'Confirm the claimed evidence when it is correct, or mark it false. A false label does not mark the entire video as no hit; review may have stopped before its remaining cards.';
}
$('feedbackReason').onchange = renderFeedback;
async function saveFeedback(action) {
  if (feedbackBusy || !currentEvidence) return;
  const entry = currentEvidence; feedbackBusy = true; renderFeedback();
  try {
    const result = await api.call('save-hit-feedback', { id: String(entry.id), action, reason: $('feedbackReason').value, note: $('feedbackNote').value, expectedTarget: entry.feedback_target });
    loadProject(result);
    toast(action === 'undo' ? 'Human label undone.' : action === 'confirmed_hit' ? 'Confirmed hit saved. Retraining will use this positive example.' : 'False hit saved. Retraining will use this negative example.');
  } finally { feedbackBusy = false; renderFeedback(); }
}
$('markConfirmed').onclick = act(() => saveFeedback('confirmed_hit'));
$('markFalseHit').onclick = act(() => saveFeedback('false_hit'));
$('undoFeedback').onclick = act(() => saveFeedback('undo'));
const choose = act(async()=>loadProject(await api.call('choose-project')));
$('chooseFolder').onclick=choose;$('emptyChoose').onclick=choose;
$('refreshProject').onclick=act(async()=>loadProject(await api.call('refresh-project')));
$('openFolder').onclick=act(()=>api.call('open-project-folder'));
const openLogs = el('button','text-button','Open logs ↗');
openLogs.id = 'openReviewLogs'; openLogs.onclick = act(()=>api.call('open-review-logs'));
document.querySelector('.worker-heading').append(openLogs);
for(const id of ['settingsBtn','connectBtn'])$(id).onclick=()=>$('settingsDialog').showModal();
let draftCriteria = { hits: [], exclusions: [] }, criteriaMeta = { customized: false };
function applyCriteriaView(doc) {
  if (!doc) return;
  cueLabels = { ...cueLabels, ...(doc.labels || Object.fromEntries((doc.hits || []).map(h => [h.id, h.label]))) };
  criteriaMeta = { customized: !!doc.customized, defaults: doc.defaults };
  draftCriteria = { hits: (doc.hits || []).map(h => ({ ...h })), exclusions: (doc.exclusions || []).map(e => ({ ...e })) };
  $('criteriaStatus').textContent = doc.customized
    ? 'Your saved rules are used for new reviews. Unfinished videos restart so they are not mixed with an older rule set.'
    : 'Built-in strict visual rules. Edit and save to use your own wording.';
  paintCriteria();
}
function paintCriteria() {
  $('hitCriteriaList').replaceChildren(...draftCriteria.hits.map((hit, index) => {
    const row = el('div', `criterion-row${hit.enabled ? '' : ' off'}`);
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!hit.enabled; check.setAttribute('aria-label', 'Use this hit cue');
    check.onchange = () => { hit.enabled = check.checked; row.classList.toggle('off', !hit.enabled); };
    const fields = el('div', 'criterion-fields');
    const name = document.createElement('input'); name.type = 'text'; name.maxLength = 80; name.value = hit.label || ''; name.placeholder = 'Short name'; name.setAttribute('aria-label', 'Hit name');
    name.oninput = () => { hit.label = name.value; };
    const prompt = document.createElement('textarea'); prompt.maxLength = 500; prompt.value = hit.prompt || ''; prompt.placeholder = 'Visible evidence the model should treat as a hit'; prompt.setAttribute('aria-label', 'Hit description');
    prompt.oninput = () => { hit.prompt = prompt.value; };
    fields.append(name, prompt);
    row.append(check, fields);
    if (hit.custom) {
      const remove = el('button', 'criterion-remove', 'Remove'); remove.type = 'button';
      remove.onclick = () => { draftCriteria.hits.splice(index, 1); paintCriteria(); };
      row.append(remove);
    }
    return row;
  }));
  $('exclusionCriteriaList').replaceChildren(...draftCriteria.exclusions.map((item, index) => {
    const row = el('div', `criterion-row${item.enabled ? '' : ' off'}`);
    const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!item.enabled; check.setAttribute('aria-label', 'Use this exclusion');
    check.onchange = () => { item.enabled = check.checked; row.classList.toggle('off', !item.enabled); };
    const fields = el('div', 'criterion-fields');
    const text = document.createElement('textarea'); text.maxLength = 280; text.value = item.text || ''; text.placeholder = 'What should not count as a hit'; text.setAttribute('aria-label', 'Exclusion');
    text.oninput = () => { item.text = text.value; };
    fields.append(text);
    row.append(check, fields);
    if (item.custom) {
      const remove = el('button', 'criterion-remove', 'Remove'); remove.type = 'button';
      remove.onclick = () => { draftCriteria.exclusions.splice(index, 1); paintCriteria(); };
      row.append(remove);
    }
    return row;
  }));
  controls();
}
$('rulesBtn').onclick = act(async () => {
  applyCriteriaView(await api.call('get-criteria'));
  $('rulesDialog').showModal();
});
$('addHitCriterion').onclick = () => {
  draftCriteria.hits.push({ id: '', label: '', prompt: '', enabled: true, custom: true });
  paintCriteria();
};
$('addExclusion').onclick = () => {
  draftCriteria.exclusions.push({ id: '', text: '', enabled: true, custom: true });
  paintCriteria();
};
$('saveCriteria').onclick = act(async () => {
  applyCriteriaView(await api.call('save-criteria', draftCriteria));
  $('rulesDialog').close();
  toast(criteriaMeta.customized ? 'Saved rules will apply to the next review. Unfinished videos will restart.' : 'Classification rules saved.');
});
$('resetCriteria').onclick = () => {
  if (!criteriaMeta.defaults) return;
  applyCriteriaView({ ...criteriaMeta.defaults, defaults: criteriaMeta.defaults, customized: false, labels: Object.fromEntries(criteriaMeta.defaults.hits.map(h => [h.id, h.label])) });
  toast('Defaults loaded. Save to apply them.');
};
function showView(view){$('preparationView').hidden=view!=='prepare';$('reviewView').hidden=view!=='review';$('matchesView').hidden=view!=='matches';$('bulkLabelView').hidden=view!=='bulk';$('troubleshootView').hidden=view!=='troubleshoot';$('prepareNav').classList.toggle('active',view==='prepare');$('reviewNav').classList.toggle('active',view==='review');$('matchesNav').classList.toggle('active',view==='matches');$('bulkLabelNav').classList.toggle('active',view==='bulk');$('troubleshootNav').classList.toggle('active',view==='troubleshoot');if(view==='bulk')window.renderBulkLabels?.();else window.suspendBulkLabels?.();window.scrollTo({top:0});}
$('reviewNav').onclick=()=>showView('review');$('prepareNav').onclick=()=>showView('prepare');$('matchesNav').onclick=()=>openMatchReview(currentMatchId||acceptedMatches()[0]?.id);$('bulkLabelNav').onclick=()=>showView('bulk');$('goReview').onclick=()=>showView('review');
$('saveKey').onclick=act(async()=>{setConnection(await api.call('save-key',{key:$('apiKey').value,remember:$('rememberKey').checked}));$('apiKey').value='';$('settingsDialog').close();toast('OpenRouter key configured. No images have been sent.');await refreshModels();});
$('forgetKey').onclick=act(async()=>{setConnection(await api.call('forget-key'));$('apiKey').value='';toast('Saved key removed.');});
$('saveScrapflyKey').onclick=act(async()=>{const value=await api.call('save-scrapfly-key',{key:$('scrapflyApiKey').value,remember:$('rememberScrapflyKey').checked});renderScrapfly(value);$('scrapflyApiKey').value='';toast(value.retried?`Scrapfly access saved. ${value.retried.toLocaleString()} rate-limited lookups queued again.`:'Scrapfly access saved.');});
$('forgetScrapflyKey').onclick=act(async()=>{renderScrapfly(await api.call('forget-scrapfly-key'));$('scrapflyApiKey').value='';toast('Saved Scrapfly key removed.');});
$('vimeoAccessMode').onchange=()=>{const mode=$('vimeoAccessMode').value;$('vimeoProfile').closest('label').hidden=!['edge','chrome'].includes(mode);$('chooseVimeoCookies').hidden=mode!=='cookies-file';};
$('chooseVimeoCookies').onclick=act(async()=>{const value=await api.call('choose-vimeo-cookies');renderVimeoAccess(value);if(!value.canceled)toast('Vimeo cookies file selected. Cookie contents stay in the file.');});
$('saveVimeoAccess').onclick=act(async()=>{const selected=$('vimeoAccessMode').value;const value=await api.call('save-vimeo-access',{mode:['edge','chrome'].includes(selected)?'browser':selected,browser:['edge','chrome'].includes(selected)?selected:undefined,profile:$('vimeoProfile').value});renderVimeoAccess(value);toast(value.retried?`Vimeo access saved. ${value.retried.toLocaleString()} verified Footage Farm screeners queued again.`:value.configured?'Vimeo access saved for official Footage Farm videos.':'Vimeo sign-in disabled.');});
$('refreshModels').onclick=refreshModels;
for(const id of ['primaryModel','secondaryModel'])$(id).onchange=()=>{prices();controls();window.refreshRecheckModels?.();};
$('verification').onchange=()=>{prices();controls();};
$('startBtn').onclick=act(async()=>{ $('startBtn').disabled=true;try{const result=await api.call('start-review',{primary:$('primaryModel').value,secondary:$('secondaryModel').value,verification:$('verification').checked,verificationMode:$('verificationMode').value,detail:$('detail').checked,budget:Number($('budget').value),workers:Number($('workers').value),videoConcurrency:Number($('videoConcurrency').value),dispatchMode:$('dispatchMode').value});if(result?.state)renderState(result.state);if(result?.alreadyRunning)toast('Review is already running. Live progress has been restored.');}finally{controls();} });
$('pauseBtn').onclick=act(()=>api.call('pause-review'));
$('search').oninput=()=>{resultPage=0;renderResults();};
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{resultPage=0;selectedFilter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b===button));renderResults();});
$('showRegion').onchange=()=>{$('regionBox').hidden=!$('showRegion').checked || !currentEvidence?.evidence?.bounds;};
$('sourceLink').onclick=act(()=>api.call('open-url',currentEvidence.url));
$('exportBtn').onclick=()=>$('exportDialog').showModal();
for(const [id,format] of [['exportCsv','csv'],['exportJson','json']])$(id).onclick=act(async()=>{const result=await api.call('export',format,$('exportScope').value);if(result){$('exportDialog').close();toast(`Exported ${result.count} results to ${result.path}`);}});
api.onState(renderState);
const bytesLabel=n=>n>=1024**3?`${(n/1024**3).toFixed(2)} GB`:`${Math.round(n/1024**2)} MB`;
const sourceOrigin=source=>source.kind==='crawled'?'crawled website':source.kind==='website'?'website source · not crawled':'imported file';
function renderPreparation(s){
  preparation=s;const c=s.counts||{},current=s.current||{};
  if(s.sources){knownSources=s.sources;const wanted=s.activeSource||'',options=()=>[el('option','','All imported URLs'),...s.sources.map(source=>{const o=el('option','',`${source.label} · ${sourceOrigin(source)} · ${Number(source.total).toLocaleString()} URLs`);o.value=source.key;return o;})];for(const id of ['activeSource','reviewSource']){$(id).replaceChildren(...options());$(id).value=wanted;}const selected=s.sources.find(source=>source.key===wanted);$('reviewSourceHeading').textContent=selected?`${selected.label} · ${sourceOrigin(selected).toUpperCase()}`:'ALL IMPORTED SOURCES';}
  $('queueMetric').textContent=(c.total||0).toLocaleString();$('queueNote').textContent=`${(c.pending||0).toLocaleString()} pending · ${(c.error||0).toLocaleString()} errors · ${(c.unavailable||0).toLocaleString()} preview unavailable`;
  $('readyMetric').textContent=s.backlog?.ready_reels||0;renderBackfill();$('retentionMetric').replaceChildren(document.createTextNode(`${c.hit||0} `),el('em','',`/ ${c.cleaned||0}`));
  $('diskMetric').textContent=bytesLabel(s.footageBytes||0);$('reclaimedNote').textContent=`Saved cards: ${bytesLabel(s.cardBytes||0)} · retained evidence: ${bytesLabel(s.retainedCardBytes||0)} · working: ${bytesLabel(s.workingCardBytes||0)}`;
  $('prepareStatus').replaceChildren(el('i'),document.createTextNode((s.status||'idle').toUpperCase()));$('prepareMessage').textContent=s.message||'Create a workspace and import URLs.';
  const pct=current.stage==='screening'?(current.total?current.screened/current.total*100:0):current.expected?Math.min(100,current.frames/current.expected*100):current.total?current.bytes/current.total*100:current.percent||0;
  $('preparePercent').textContent=current.id?`${Math.round(pct)}%`:'—';$('prepareFill').style.width=`${pct}%`;
  $('prepareDetail').textContent=current.id?current.stage==='screening'?`${current.id} · screening people locally${current.localWorkers?` · ${current.localWorkers} local workers`:''}${current.parallelVideos>1?` · ${current.parallelVideos} videos in preparation`:''} · ${current.screened||0} / ${current.total||0} frames · ${current.selected||0} selected`:`${current.id} · ${current.stage}${current.frames?` · ${current.frames.toLocaleString()} / ${current.expected.toLocaleString()} frames`:current.bytes?` · ${bytesLabel(current.bytes)} downloaded`:''}`:'Preparation runs independently of the model connection.';
  // The resolver reads the latest Scrapfly key before each metadata request,
  // so access can be saved without interrupting preparation or crawling.
  for(const id of ['scrapflyApiKey','rememberScrapflyKey'])$(id).disabled=false;
  $('saveScrapflyKey').disabled=false;
  const mediaAccessBusy=['running','buffered','pausing','crawling'].includes(s.status);
  $('forgetScrapflyKey').disabled=mediaAccessBusy;
  for(const id of ['vimeoAccessMode','vimeoProfile','chooseVimeoCookies','saveVimeoAccess'])$(id).disabled=mediaAccessBusy;
  for(const node of document.querySelectorAll('.preparation-metrics small,#prepareMessage,#prepareDetail'))node.title=node.textContent;
  const rows=s.recent||[];$('prepareEmpty').hidden=rows.length>0;$('preparedCount').textContent=rows.length?`${rows.length} recent`:0;
  $('preparedBody').replaceChildren(...rows.map(r=>{const tr=el('tr',r.status==='ready'||r.status==='hit'?'result-row':'');const id=el('td');id.append(el('strong','',r.id));if(r.title)id.append(el('small','row-title',r.title));const status=el('td');status.append(el('span',`pill stage-${r.status}`,r.status));tr.append(id,status,el('td','',r.duration?`${Math.floor(r.duration/60)}m ${Math.round(r.duration%60)}s`:'—'),el('td','',r.frame_count?.toLocaleString()||'—'),el('td','',r.card_count||'—'),el('td','',r.error|| (r.owner_id&&r.owner_id!==r.id?`Same reviewed clip as ${r.owner_id}`:r.status==='cleaned'?'Completed review · generated media removed':r.status==='ready'?'Click to preview cards':r.status==='hit'?'Hit cards saved · source video deleted':'')));if(['ready','hit'].includes(r.status)){tr.tabIndex=0;const open=act(async()=>{const data=await api.call('preview-prepared',r.id);$('preparedTitle').textContent=r.id;$('preparedInfo').textContent=`${data.receipt.frame_count.toLocaleString()} frames · ${data.receipt.card_count} cards · ${data.receipt.fps} fps · ${data.receipt.scope==='segment' ? 'story '+data.receipt.segment_start+'–'+data.receipt.segment_end+'s' : 'whole video'} · + / click / Ctrl+wheel to zoom`;$('preparedImage').src=data.image.data;preparedZoom.reset();$('preparedDialog').showModal();});tr.onclick=open;tr.onkeydown=e=>{if(e.key==='Enter')open();};}return tr;}));controls();
}
$('createWorkspace').onclick=act(async()=>{loadProject(await api.call('create-workspace'));toast('Footage workspace ready. Import the URL collection.');});
async function importSource(file){if(!project)loadProject(await api.call('create-workspace'));const result=await api.call('import-source',file);if(result)toast(`${result.added.toLocaleString()} URLs imported. ${result.alreadyPresent.toLocaleString()} duplicates skipped.`);}
$('importDetected').onclick=act(()=>importSource($('sourceCollection').value));$('browseSource').onclick=act(()=>importSource(null));
$('sourceCollection').onchange=()=>{$('sourceDetail').textContent=$('sourceCollection').value||'Choose a collection.';};
const websitePresets={footagefarm:{url:'https://footagefarm.com/',detail:'Footage Farm uses its tailored theme → subtheme → reel catalog adapter.'},myfootage:{url:'https://www.myfootage.com/',detail:'Add MyFootage without contacting the site. After permission is confirmed, the crawler reads the complete public video catalog through the site’s four official format partitions.'}};
function renderWebsiteSource(resetUrl=false){const selected=$('sourceWebsite').value,preset=websitePresets[selected],myfootage=selected==='myfootage';if(resetUrl&&preset)$('crawlUrl').value=preset.url;$('sourcePermission').hidden=!myfootage;if(!myfootage)$('crawlPermission').checked=false;$('crawlWebsite').disabled=myfootage&&!$('crawlPermission').checked;$('crawlWebsite').textContent=myfootage?'↻ Crawl authorized source':'↻ Crawl source';$('sourceDetail').textContent=preset?.detail||'Add the website as a separate queue, or crawl its same-site public video pages.';}
$('sourceWebsite').onchange=()=>renderWebsiteSource(true);
$('crawlUrl').oninput=()=>{let host='';try{host=new URL($('crawlUrl').value).hostname.toLowerCase().replace(/^www\./,'');}catch{}const detected=host==='myfootage.com'?'myfootage':host==='footagefarm.com'?'footagefarm':'custom';if($('sourceWebsite').value!==detected){$('sourceWebsite').value=detected;renderWebsiteSource(false);}};
$('crawlPermission').onchange=()=>renderWebsiteSource(false);
$('addWebsiteSource').onclick=act(async()=>{if(!project)loadProject(await api.call('create-workspace'));const result=await api.call('add-website-source',{url:$('crawlUrl').value});prefs.activeSource=result.sourceKey;toast(`${result.label} added as an empty source. No website request was made.`);});
$('crawlWebsite').onclick=act(async()=>{if(!project)loadProject(await api.call('create-workspace'));const isMyFootage=$('sourceWebsite').value==='myfootage';const result=await api.call('crawl-website',{url:$('crawlUrl').value,authorized:isMyFootage&&$('crawlPermission').checked});prefs.activeSource=result.sourceKey;const catalogNote=isMyFootage&&Number.isFinite(result.catalogTotal)?` ${result.catalogTotal.toLocaleString()} catalog rows checked; ${Number(result.skipped||0).toLocaleString()} non-video or unplayable records omitted.`:'';toast(`${result.label} catalog ready: ${result.total.toLocaleString()} unique video URLs from ${Number(result.pages||result.subthemes||0).toLocaleString()} pages.${catalogNote}`);if(isMyFootage)$('crawlPermission').checked=false;renderWebsiteSource(false);});
renderWebsiteSource(false);
async function switchSource(select){const key=select.value;const label=select.selectedOptions[0]?.textContent||'selected source';const result=await api.call('set-active-source',key);prefs.activeSource=key;renderPreparation(result.preparation);loadProject(result.project);toast(`Switched to ${label}. Preparation and new visual review use this source; saved-hit screens include every source.`);}
$('activeSource').onchange=act(()=>switchSource($('activeSource')));
$('reviewSource').onchange=act(()=>switchSource($('reviewSource')));
$('startPreparation').onclick=act(async()=>{await api.call('start-preparation',{fps:Number($('sampleFps').value),width:Number($('frameWidth').value),buffer:Number($('readyBuffer').value),maxGB:Number($('storageLimit').value)});prefs.autoBackfill=true;renderBackfill();controls();});
$('pausePreparation').onclick=act(async()=>{await api.call('pause-preparation');prefs.autoBackfill=false;renderBackfill();controls();});$('retryPreparation').onclick=act(()=>api.call('retry-preparation'));$('syncVerdicts').onclick=act(()=>api.call('sync-verdicts'));$('cleanupMedia').onclick=act(async()=>{const result=await api.call('cleanup-media');renderPreparation(result.state);toast(result.reclaimed?`Cleaned up ${bytesLabel(result.reclaimed)} of temporary media.`:'No disposable media remains.');});
$('autoBackfill').onchange=act(async()=>{prefs.autoBackfill=await api.call('set-auto-backfill',$('autoBackfill').checked);renderBackfill();controls();});
api.onPreparation(renderPreparation);api.onProject(loadProject);
function mergeResult(list,entry,hitsOnly=false){
  if(hitsOnly&&entry.verdict!=='jewish')return null;
  const merge=(target,value,replace)=>{const ids=[...new Set([...(target.catalog_ids||[String(target.id)]),...(value.catalog_ids||[String(value.id)])])],sources=[...new Set([...entrySourceKeys(target),...entrySourceKeys(value)])];if(replace)Object.assign(target,value);Object.assign(target,{catalog_ids:ids,catalog_id_count:ids.length,source_keys:sources,source_count:sources.length});return target;};
  const index=list.findIndex(value=>String(value.id)===String(entry.id));if(index>=0)return merge(list[index],entry,true);
  if(entry.verdict==='jewish'&&entry.feedback_target){const same=list.find(value=>value.verdict==='jewish'&&value.feedback_target===entry.feedback_target);if(same)return merge(same,entry,false);}
  list.push(entry);return entry;
}
api.onVerdict(entry=>{mergeResult(entries,entry);mergeResult(hitEntries,entry,true);renderResults();renderMatchCount();window.invalidateBulkLabels?.();window.renderBulkLabels?.();if(!$('matchesView').hidden&&!currentMatchId&&isAcceptedHit(entry))selectMatch(entry.id);});
(async()=>{try{const data=await api.call('bootstrap');document.title='Jewish Reels '+data.version+' · Archive Review';document.querySelector('footer>span').textContent='JEWISH REELS '+data.version+' · ARCHIVE REVIEW WORKSPACE';applyCriteriaView(data.criteria);prefs=data.settings;for(const [id,key] of [['sampleFps','fps'],['frameWidth','width'],['readyBuffer','buffer'],['storageLimit','maxGB']])if(prefs.preparation?.[key])$(id).value=String(prefs.preparation[key]);setConnection(data.connection);renderScrapfly(prefs.scrapfly);renderVimeoAccess(prefs.vimeoAccess);$('verification').checked=prefs.verification;$('verificationMode').value=prefs.verificationMode||'positives';$('detail').checked=prefs.detail;$('budget').value=prefs.budget;$('workers').value=String(prefs.workers ?? 4);$('videoConcurrency').value=String(prefs.videoConcurrency ?? 4);$('dispatchMode').value=prefs.dispatchMode||'one-at-a-time';$('recheckBudget').value=String(prefs.recheckBudget||10);$('recheckWorkers').value=String(prefs.recheckWorkers||16);renderState(data.state);window.renderRecheck?.(data.recheck);renderPreparation(data.preparation);$('sourceCollection').replaceChildren(...(data.sources?.length?data.sources.map(s=>{const o=el('option','',s.label);o.value=s.file;return o;}):[el('option','','Browse a URL list…')]));$('sourceDetail').textContent=$('sourceCollection').value;if(prefs.folder)try{loadProject(await api.call('reopen-project'));renderPreparation(await api.call('get-preparation'));prefs.activeSource=$('reviewSource').value;}catch(e){toast('Previous project could not be reopened: '+e.message,true);}await refreshModels();window.refreshRecheckModels?.();}catch(e){toast(e.message,true);}})();
