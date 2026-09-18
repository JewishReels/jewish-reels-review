const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, nativeImage, Menu } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const S = require('./lib/storage.cjs');
const API = require('./lib/openrouter.cjs');
const { ReviewEngine } = require('./lib/engine.cjs');
const { makeImageAdapter } = require('./lib/images.cjs');
const { PreparationPipeline } = require('./lib/pipeline.cjs');
const { detectSources } = require('./lib/queue.cjs');
const R = require('./lib/recovery.cjs');
const F = require('./lib/feedback.cjs');
const L = require('./lib/learning-store.cjs');
const {LearningEngine} = require('./lib/learning-engine.cjs');
const {makeLearningImages} = require('./lib/learning-images.cjs');
const {HitRecheck} = require('./lib/hit-recheck.cjs');
const Policy = require('./lib/policy.cjs');
const V = require('./lib/result-view.cjs');
const VimeoAuth = require('./lib/vimeo-auth.cjs');
const sharp = require('sharp');

const testMode = process.env.REELSIGHT_TEST === '1';
if(testMode)app.disableHardwareAcceleration();
// Branding may change, but the Windows profile is a durable data identity.
// Keep settings, encrypted connection data and the last workspace in the
// original ReelSight profile across renamed releases.
app.setPath('userData', path.join(app.getPath('appData'), 'ReelSight'));
if (testMode && process.env.REELSIGHT_TEST_USERDATA) app.setPath('userData', process.env.REELSIGHT_TEST_USERDATA);
app.setName('Jewish Reels');
let win, selectedProject = null, catalog = [], settings = {}, secret = process.env.OPENROUTER_API_KEY || '', engine, pipeline, learner, hitRecheck, starting = false,crawlWorker=null;
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function send(channel, value) { if (win && !win.isDestroyed()) win.webContents.send(channel, value); }
let persistWrites=Promise.resolve();
async function persist() {
  const snapshot=JSON.parse(JSON.stringify(settings));
  persistWrites=persistWrites.catch(()=>{}).then(()=>S.atomicJson(settingsFile(),snapshot));
  return persistWrites;
}
function connectionStatus() { return { configured: !!secret, remembered: !!settings.encryptedKey, environment: !!process.env.OPENROUTER_API_KEY }; }
function vimeoAccessStatus() {
  try { return VimeoAuth.publicVimeoAuth(settings.vimeoAuth); }
  catch { return { mode: 'none', configured: false }; }
}
async function projectCounts(p) {
  const feedback = await F.load(p.root),active=F.active(feedback);
  return {
    root: p.root,
    videoCount: p.videos.length + p.issues.length,
    cardCount: p.videos.reduce((n,v) => n + v.cards.length, 0),
    // The review dashboard stays scoped to the selected source. Saved model
    // hits remain visible across the workspace for match review and labeling.
    entries: V.summaries(p.entries, feedback),
    hitEntries: V.summaries(p.workspaceHits || p.entries.filter(entry => entry.verdict === 'jewish'), feedback),
    feedback: { active: active.length, confirmed: active.filter(e=>e.action==='confirmed_hit').length, false: active.filter(e=>e.action==='false_hit').length, checks: F.context(feedback).reasons.length }
  };
}
function projectProgress(p) { return { total: new Set([...p.videos, ...p.entries, ...p.issues].map(v => String(v.id))).size, done: p.entries.length, hits: p.entries.filter(e => e.verdict === 'jewish').length }; }
async function projectDeferred(p) {
  const saved = await S.readJson(path.join(p.root,'logs','reelsight_deferred.json'), { version: 1, videos: [] });
  if (saved.version !== 1 || !Array.isArray(saved.videos)) throw new Error('Invalid deferred-work journal. Preserved for diagnosis.');
  const judged = new Set(p.entries.map(v => String(v.id)));
  return [...new Map([...p.issues, ...saved.videos.filter(v => v.manual && !judged.has(String(v.id)))].map(v => [v.id,v])).values()];
}
function noRun() { if (engine.running || learner?.running || hitRecheck?.running || starting) throw new Error('Pause the current review, learning pass, or saved-hit recheck before changing projects or settings.'); }
function activePolicy() { return Policy.compile(settings.criteria); }
function criteriaView() { return Policy.view(settings.criteria); }
function ensureBackfill() {
  if (!settings.autoBackfill || !pipeline?.store || pipeline.running) return;
  const counts = pipeline.store.counts();
  if (!(counts.pending || counts.resolving || counts.downloading || counts.extracting)) return;
  pipeline.run(settings.preparation).catch(e=>pipeline.update({status:'error',message:e.message}));
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted request.');
    try { return { ok: true, value: await fn(...args) }; } catch (e) { return { ok: false, error: String(e.message || e).replace(/sk-or-[\w-]+/g, '[redacted]') }; }
  });
}
async function openProject(folder) {
  noRun();
  if (pipeline?.running && path.resolve(folder) !== selectedProject?.root) throw new Error('Pause footage preparation before changing workspaces.');
  let project = await S.discover(folder,{sourceKey:settings.activeSource||null});
  matchImageCache.clear(); selectedProject = project; settings.folder = project.root; await persist();
  await pipeline.open(project.root);
  // Opening the queue may quarantine a legacy source association and
  // supersede its verdict. Rediscover after those durable migrations so the
  // renderer never continues with the pre-migration completion snapshot.
  project = await S.discover(project.root,{sourceKey:settings.activeSource||null});
  selectedProject = project;
  const available=pipeline.store.sourcesList();
  if(settings.activeSource&&!available.some(s=>s.key===settings.activeSource)){delete settings.activeSource;project=await S.discover(folder);}
  if(!settings.activeSource&&available.length===1){settings.activeSource=available[0].key;project=await S.discover(folder,{sourceKey:settings.activeSource});await persist();}
  pipeline.store.setActiveSource(settings.activeSource||null);pipeline.update({activeSource:settings.activeSource||null,sources:available});
  await engine.openWorkspace(project.root);
  hitRecheck?.info(project.root,activePolicy()).catch(error=>hitRecheck.update({status:'error',message:error.message}));
  const deferred = await projectDeferred(project);
  engine.update({ status: 'idle', message: project.videos.length ? 'Project ready. Select a model and start review.' : project.issues.length ? 'Some videos are waiting for file recovery. Start review to retry automatically.' : project.entries.length ? 'Previous reviews are saved. Start footage preparation for the next videos.' : 'No contact sheets found in this project.', ...projectProgress(project), deferred, current: null, cardsReviewed: 0, disagreements: 0 });
  await engine.live(project.root, { message: engine.state.message });
  ensureBackfill();
  return projectCounts(project);
}
async function localJpeg(relative) {
  if (!selectedProject || typeof relative !== 'string') throw new Error('Select a project first.');
  const root = await fs.realpath(selectedProject.root);
  const resolved = await fs.realpath(path.resolve(root, relative));
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !/\.jpe?g$/i.test(resolved)) throw new Error('Image must be a JPEG within the selected project.');
  const stat = await fs.stat(resolved);
  if (stat.size > 40_000_000) throw new Error('Preview is limited to 40 MB per image.');
  return { resolved, stat };
}
async function localImage(relative) {
  const { resolved } = await localJpeg(relative);
  const img = nativeImage.createFromPath(resolved);
  if (img.isEmpty()) throw new Error('This image cannot be opened.');
  return { data: `data:image/jpeg;base64,${(await fs.readFile(resolved)).toString('base64')}`, size: img.getSize() };
}
const matchImageCache = new Map();
async function matchImage({ relative, full = false, maxWidth = 1600, maxHeight = 1050 } = {}) {
  if (typeof full !== 'boolean' || !Number.isInteger(maxWidth) || !Number.isInteger(maxHeight) || maxWidth < 480 || maxWidth > 5000 || maxHeight < 360 || maxHeight > 5000) throw new Error('Invalid match preview size.');
  const { resolved, stat } = await localJpeg(relative);
  const key = `${resolved}:${stat.size}:${stat.mtimeMs}:${full?'full':`${maxWidth}x${maxHeight}`}`;
  if (!full && matchImageCache.has(key)) {
    const saved = matchImageCache.get(key); matchImageCache.delete(key); matchImageCache.set(key,saved); return saved;
  }
  // NativeImage is already available in Electron and avoids starting a native
  // image-processing pipeline for every first-page preview.
  const source=nativeImage.createFromPath(resolved);
  if(source.isEmpty())throw new Error('This evidence image has invalid dimensions.');
  const originalSize=source.getSize(),ratio=Math.min(1,maxWidth/originalSize.width,maxHeight/originalSize.height);
  const reduced=!full&&ratio<1;
  const preview=reduced?source.resize({width:Math.max(1,Math.round(originalSize.width*ratio)),height:Math.max(1,Math.round(originalSize.height*ratio)),quality:'good'}):source;
  const buffer=reduced?preview.toJPEG(84):await fs.readFile(resolved),size=preview.getSize();
  const value = { data:`data:image/jpeg;base64,${buffer.toString('base64')}`, size, originalSize, full:!reduced };
  // Full-resolution images are loaded only on request and are not retained in
  // memory. The small LRU is reserved for display previews used while paging.
  if(!full){matchImageCache.set(key,value);while(matchImageCache.size>24)matchImageCache.delete(matchImageCache.keys().next().value);}
  return value;
}
async function createWindow() {
  settings = await S.readJson(settingsFile(), {}).catch(() => ({}));
  const removedFrameFilter = Object.prototype.hasOwnProperty.call(settings,'frameFilter');
  if (removedFrameFilter) delete settings.frameFilter;
  let mergedExistingRules=false;
  if (settings.criteria != null) {
    try { const result=Policy.mergeExistingLearnedRules(settings.criteria);settings.criteria=result.document;mergedExistingRules=result.changed; }
    catch { delete settings.criteria; }
  }
  if(mergedExistingRules || removedFrameFilter)await persist();
  // Older buffers counted aliases as work. Start the new reserve at three real reels.
  if (settings.backfillVersion !== 1) { settings.preparation = { fps: 1, width: 960, maxGB: 20, ...settings.preparation, buffer: 3 }; settings.backfillVersion = 1; }
  if (settings.adaptiveSamplingVersion !== 1) { settings.preparation = { width: 960, maxGB: 20, buffer: 3, ...settings.preparation, fps: 4 }; settings.adaptiveSamplingVersion = 1; }
  if (settings.fixedSamplingRollbackVersion !== 1) { settings.preparation = { width: 960, maxGB: 20, buffer: 3, ...settings.preparation, fps: 1 }; settings.fixedSamplingRollbackVersion = 1; }
  settings.autoBackfill ??= !testMode;
  const preparedDefault = app.isPackaged ? path.join(path.dirname(path.dirname(app.getPath('exe'))),'Footage Workspace') : path.resolve(__dirname,'../../outputs/Footage Workspace');
  if(!testMode && !settings.folder && await S.exists(path.join(preparedDefault,'.pipeline','queue.sqlite'))) settings.folder=preparedDefault;
  if (!secret && settings.encryptedKey) {
    try { secret = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64')); } catch { delete settings.encryptedKey; }
  }
  engine = new ReviewEngine({ reviewer: API.reviewImage, prepareCard: makeImageAdapter(nativeImage) });
  learner = new LearningEngine({ analyze: API.analyzeMistake, prepareImages: makeLearningImages(nativeImage), account: async data => { await engine.usage.record(data); engine.update(engine.usage.snapshot()); } });
  hitRecheck = new HitRecheck({ reviewer: API.reviewImage, account: async data => { await engine.usage.record(data); engine.update(engine.usage.snapshot()); } });
  learner.on('state', s => send('learning-state',s));
  learner.on('finished', () => send('learning-updated',true));
  hitRecheck.on('state', s => send('hit-recheck-state',s));
  const bin = app.isPackaged ? path.join(process.resourcesPath, 'media-tools') : path.resolve(__dirname, '../package-resources/media-tools');
  pipeline = new PreparationPipeline({ getReviewLoad:()=>({workers:settings.workers??4,videoConcurrency:settings.videoConcurrency??4}), tools: { ffmpeg: path.join(bin,'ffmpeg.exe'), ffprobe: path.join(bin,'ffprobe.exe'), ytdlp: path.join(bin,'yt-dlp.exe'), getVimeoAuth:()=>VimeoAuth.normalizeVimeoAuth(settings.vimeoAuth) } });
  let pendingPrepareState=null,prepareStateTimer=null;
  const flushPrepareState=()=>{prepareStateTimer=null;if(pendingPrepareState){const value=pendingPrepareState;pendingPrepareState=null;send('prepare-state',value);}};
  pipeline.on('state', s => { pendingPrepareState=s;if(!prepareStateTimer)prepareStateTimer=setTimeout(flushPrepareState,250); });
  let changeTask=null,changeAgain=false;
  const changed = async () => {
    changeAgain=true;
    if(changeTask)return changeTask;
    changeTask=(async()=>{do{changeAgain=false;await R.sleep(75);if(selectedProject){const p=await S.discover(selectedProject.root,{sourceKey:settings.activeSource||null});selectedProject=p;send('project-updated',await projectCounts(p));if(!engine.running)engine.update({...projectProgress(p),deferred:await projectDeferred(p)});}}while(changeAgain);})();
    try{return await changeTask;}finally{changeTask=null;}
  };
  pipeline.on('ready', () => changed().catch(e => { pipeline.update({ message: `Queue refresh will retry: ${e.message}` }); R.logRecovery(pipeline.root, { event: 'queue-refresh-failed', error: e.message, error_code: e.code }).catch(()=>{}); }));
  let pendingReviewState={},pendingReviewDeferred,reviewStateTimer=null;
  const flushReviewState=()=>{if(reviewStateTimer){clearTimeout(reviewStateTimer);reviewStateTimer=null;}const value={...pendingReviewState,...(pendingReviewDeferred===undefined?{}:{deferred:pendingReviewDeferred})};pendingReviewState={};pendingReviewDeferred=undefined;send('review-state',value);};
  engine.on('state', s => {
    if(Object.prototype.hasOwnProperty.call(s,'deferred')){pendingReviewDeferred=s.deferred;pipeline.setDeferredItems(s.deferred);}
    const {deferred,...light}=s;pendingReviewState=light;
    pipeline.setReviewIds(['running','pausing'].includes(s.status) ? (s.videos || []).map(v => v.id) : []);
    if(['paused','attention','complete','error'].includes(s.status))flushReviewState();
    else if(!reviewStateTimer)reviewStateTimer=setTimeout(flushReviewState,250);
  }); engine.on('verdict', e => { F.load(selectedProject.root).then(journal => send('new-verdict', V.summaries([e], journal)[0])).catch(err=>engine.event(err.message,'warning')); });
  // Cleanup must run after the review task releases its ID; an earlier verdict
  // event is intentionally skipped while that ID is still protected as active.
  // Settling is the one ordered synchronization point for both verdicts and
  // deferred failures, avoiding two full maintenance sweeps per video.
  engine.on('video-settled', () => pipeline.syncVerdicts().then(changed).catch(err=>pipeline.update({message:err.message})));
  win = new BrowserWindow({ width: 1450, height: 980, minWidth: 1120, minHeight: 760, show: false, title: 'Jewish Reels · Archive Review', backgroundColor: '#f3eee4', icon: path.join(__dirname, 'assets', 'icon.ico'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true } });
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  win.webContents.on('did-finish-load', () => { if (win.webContents.zoomFactor < 1) win.webContents.zoomFactor = 1; });
  win.webContents.setVisualZoomLevelLimits(1, 5).catch(() => {});
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  win.on('close', e => {
    if (engine.running || pipeline.running || learner.running || hitRecheck.running) {
      const answer = dialog.showMessageBoxSync(win, { type: 'question', buttons: ['Keep working', 'Pause and close'], defaultId: 0, cancelId: 0, title: 'Work in progress', message: 'Pause before closing?', detail: 'Downloaded footage and completed image reviews are saved. An in-flight API request may already be billed and will need to be repeated if its result has not been saved.' });
      if (answer === 0) e.preventDefault();
      else { e.preventDefault(); if(engine.running) engine.pause(); if(learner.running)learner.pause(); if(hitRecheck.running)hitRecheck.pause(); if(pipeline.running) pipeline.pause(); const check = setInterval(() => { if (!engine.running && !pipeline.running && !learner.running && !hitRecheck.running) { clearInterval(check); win.destroy(); app.quit(); } }, 250); }
    }
  });
  handle('bootstrap', async () => ({ settings: { folder: settings.folder, activeSource:settings.activeSource, primary: settings.primary, secondary: settings.secondary, verification: settings.verification ?? true, verificationMode: settings.verificationMode || 'positives', detail: settings.detail ?? true, budget: settings.budget || 10, workers: settings.workers ?? 4, videoConcurrency: settings.videoConcurrency ?? 4, dispatchMode: settings.dispatchMode || 'one-at-a-time', recheckBudget:settings.recheckBudget||10, recheckWorkers:settings.recheckWorkers||16, autoBackfill: settings.autoBackfill, preparation: settings.preparation, vimeoAccess:vimeoAccessStatus() }, connection: connectionStatus(), state: engine.snapshot(), recheck:hitRecheck.snapshot(), preparation: pipeline.snapshot(), sources: await detectSources(app.getPath('documents')), version: app.getVersion(), criteria: criteriaView() }));
  handle('get-criteria', () => criteriaView());
  handle('save-criteria', async document => {
    settings.criteria = Policy.mergeExistingLearnedRules(document).document;
    await persist();
    return criteriaView();
  });
  handle('reset-criteria', async () => {
    noRun();
    delete settings.criteria;
    await persist();
    return criteriaView();
  });
  handle('create-workspace', async () => {
    noRun(); if(pipeline.running) throw new Error('Pause preparation first.');
    const root = app.isPackaged ? path.join(path.dirname(path.dirname(app.getPath('exe'))),'Footage Workspace') : path.resolve(__dirname,'../../outputs/Footage Workspace');
    await fs.mkdir(path.join(root,'frames'), {recursive:true}); return openProject(root);
  });
  handle('import-source', async file => {
    if(!selectedProject) throw new Error('Create a footage workspace first.');
    if(pipeline.running) throw new Error('Pause preparation before importing.');
    if(!file) { const choice=await dialog.showOpenDialog(win,{title:'Import a Shtetl database or URL list',properties:['openFile'],filters:[{name:'URL collections',extensions:['db','sqlite','sqlite3','csv','tsv','txt','json']}]}); if(choice.canceled)return null; file=choice.filePaths[0]; }
    else { const known=await detectSources(app.getPath('documents')); if(!known.some(s=>s.file===file))throw new Error('Choose the URL list through Browse.'); }
    const result = await pipeline.import(file); settings.activeSource=result.sourceKey;await persist();selectedProject=await S.discover(selectedProject.root,{sourceKey:result.sourceKey});send('project-updated',await projectCounts(selectedProject));ensureBackfill(); return result;
  });
  handle('add-website-source', async ({url}={}) => {
    if(!selectedProject)throw new Error('Create a footage workspace first.');
    noRun();if(pipeline.running)throw new Error('Pause preparation before adding a source.');
    let parsed;try{parsed=new URL(String(url||''));}catch{throw new Error('Enter a complete website URL, including https://.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Enter a public HTTP(S) website URL.');
    const host=parsed.hostname.toLowerCase().replace(/^www\./,''),known=host==='myfootage.com'?{key:'myfootage',label:'MyFootage',homepage:'https://www.myfootage.com/'}:host==='footagefarm.com'?{key:'footagefarm',label:'Footage Farm',homepage:'https://footagefarm.com/'}:null;
    const key=known?.key||host.replace(/[^a-z0-9]+/g,'-'),label=known?.label||parsed.hostname.replace(/^www\./,''),homepage=known?.homepage||parsed.origin+'/';
    const result=pipeline.registerSource({sourceKey:key,label,homepage,kind:'website'});settings.activeSource=key;await persist();selectedProject=await S.discover(selectedProject.root,{sourceKey:key});send('project-updated',await projectCounts(selectedProject));return result;
  });
  handle('crawl-website', async ({url,authorized=false}={}) => {
    if(!selectedProject)throw new Error('Create a footage workspace first.');
    noRun();if(pipeline.running)throw new Error('Pause preparation before crawling a source.');
    let parsed;try{parsed=new URL(String(url||''));}catch{throw new Error('Enter a complete website URL, including https://.');}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw new Error('Enter a public HTTP(S) website URL.');
    const host=parsed.hostname.toLowerCase().replace(/^www\./,'');
    if(host==='myfootage.com'&&authorized!==true)throw new Error('MyFootage crawling is locked. Confirm that you have permission to crawl this source before starting.');
    const key=parsed.hostname.toLowerCase().replace(/^www\./,'').replace(/[^a-z0-9]+/g,'-'),file=path.join(selectedProject.root,'.pipeline','sources',`${key}.json`);
    starting=true;
    pipeline.update({status:'crawling',message:`Reading ${parsed.hostname} public catalog…`});
    try{
      const crawl=await new Promise((resolve,reject)=>{let settled=false,last=0;crawlWorker=new Worker(path.join(__dirname,'lib','crawl-worker.cjs'),{workerData:{startUrl:parsed.href,output:file,concurrency:6,authorized:host==='myfootage.com'&&authorized===true}});crawlWorker.on('message',message=>{if(message.type==='progress'){const now=Date.now();if(now-last>400){last=now;const p=message.value;pipeline.update({status:'crawling',crawl:p,message:`Reading ${parsed.hostname} · ${p.completed.toLocaleString()} pages · ${p.reels.toLocaleString()} video URLs`});}}else if(message.type==='done'){settled=true;resolve(message.value);}else if(message.type==='error'){settled=true;reject(new Error(message.error));}});crawlWorker.on('error',reject);crawlWorker.on('exit',code=>{crawlWorker=null;if(!settled)reject(new Error(code?'Website crawl worker stopped unexpectedly.':'Website crawl was paused.'));});});
      const result=await pipeline.import(file,{sourceKey:crawl.sourceKey,label:crawl.label,kind:'crawled'});settings.activeSource=crawl.sourceKey;await persist();
      selectedProject=await S.discover(selectedProject.root,{sourceKey:crawl.sourceKey});send('project-updated',await projectCounts(selectedProject));ensureBackfill();return{...result,...crawl,queueTotal:result.total};
    }catch(e){pipeline.update({status:e.message.includes('paused')?'paused':'error',message:`Website crawl stopped: ${e.message}`});throw e;}finally{starting=false;crawlWorker=null;}
  });
  handle('set-active-source', async key => {
    noRun();if(pipeline.running)throw new Error('Pause preparation before switching sources.');
    pipeline.setActiveSource(key);settings.activeSource=key;await persist();selectedProject=await S.discover(selectedProject.root,{sourceKey:key||null});
    const result=await projectCounts(selectedProject);send('project-updated',result);ensureBackfill();return{project:result,preparation:pipeline.snapshot()};
  });
  handle('start-preparation', async opts => { if(!selectedProject) throw new Error('Create a workspace first.'); if(pipeline.running)throw new Error('Preparation already running.'); settings.preparation=opts; settings.autoBackfill=true; await persist(); ensureBackfill(); return true; });
  handle('pause-preparation', async () => { settings.autoBackfill=false; await persist(); if(crawlWorker){const worker=crawlWorker;crawlWorker=null;await worker.terminate();pipeline.update({status:'paused',message:'Website crawl paused. Run it again to resume from its saved catalog checkpoint.'});}else if(pipeline.running)pipeline.pause();return true; });
  handle('set-auto-backfill', async enabled => { if(typeof enabled!=='boolean')throw new Error('Choose whether to keep cards ready.'); settings.autoBackfill=enabled; await persist(); if(enabled)ensureBackfill();else if(pipeline.running)pipeline.pause();return enabled; });
  handle('retry-preparation', () => { if(pipeline.running)throw new Error('Pause preparation first.');pipeline.store?.retry();pipeline.update();return true; });
  handle('sync-verdicts', async () => { await pipeline.syncVerdicts(); await changed(); return pipeline.snapshot(); });
  handle('cleanup-media', async () => { const result=await pipeline.cleanupNow(); await changed(); return result; });
  handle('get-preparation', () => pipeline.snapshot());
  handle('preview-prepared', async id => {
    if(!selectedProject || !/^[a-z0-9-]+$/.test(id))throw new Error('Select a prepared video.');
    const receipt = await S.readJson(path.join(selectedProject.root,'frames',id,'prepared.json'),null);
    if(!receipt)throw new Error('No prepared contact sheet is available.');
    const owner=receipt.shared_from || id,card=await (async()=>{for(const candidate of receipt.cards)if(await S.exists(path.join(selectedProject.root,'frames',owner,'cards',candidate.name)))return candidate;return null;})();
    if(!card)throw new Error('No saved contact sheet is available.');
    return {receipt,image:await localImage(`frames/${owner}/cards/${card.name}`)};
  });
  handle('choose-project', async () => {
    noRun(); const choice = await dialog.showOpenDialog(win, { title: 'Choose the newsreel project folder', properties: ['openDirectory'] });
    return choice.canceled ? null : openProject(choice.filePaths[0]);
  });
  handle('reopen-project', () => settings.folder ? openProject(settings.folder) : null);
  handle('refresh-project', () => selectedProject ? openProject(selectedProject.root) : null);
  handle('get-models', async () => {
    try { catalog = await API.listModels(secret); settings.catalog = catalog; settings.catalogAt = new Date().toISOString(); await persist(); return { models: catalog, cached: false }; }
    catch (e) { catalog = API.visionReviewers(settings.catalog); if (catalog.length) return { models: catalog, cached: true, error: e.message, at: settings.catalogAt }; throw e; }
  });
  handle('save-key', async ({ key, remember }) => {
    noRun();
    if (typeof key !== 'string' || !key.trim()) throw new Error('Enter an OpenRouter API key.');
    if (remember && !safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable. Turn off Remember to use the key for this session.');
    secret = key.trim();
    if (remember) settings.encryptedKey = safeStorage.encryptString(secret).toString('base64'); else delete settings.encryptedKey;
    await persist(); return connectionStatus();
  });
  handle('forget-key', async () => { noRun(); secret = ''; delete settings.encryptedKey; await persist(); return connectionStatus(); });
  handle('choose-vimeo-cookies', async () => {
    if (pipeline.running || crawlWorker) throw new Error('Pause footage preparation before changing Vimeo access.');
    const choice=await dialog.showOpenDialog(win,{title:'Choose exported Vimeo cookies',properties:['openFile'],filters:[{name:'Netscape cookies file',extensions:['txt']},{name:'All files',extensions:['*']}]});
    if(choice.canceled)return {...vimeoAccessStatus(),canceled:true};
    const file=choice.filePaths[0],stat=await fs.stat(file);
    if(!stat.isFile()||stat.size>20*1024*1024)throw new Error('Choose a cookies text file smaller than 20 MB.');
    const header=(await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'').slice(0,200);
    if(!/^# (?:Netscape )?HTTP Cookie File\b/i.test(header))throw new Error('Choose a Netscape-format cookies file. Its first line must identify it as an HTTP Cookie File.');
    settings.vimeoAuth=VimeoAuth.normalizeVimeoAuth({mode:'cookies-file',path:file});
    await persist();return vimeoAccessStatus();
  });
  handle('save-vimeo-access', async ({mode,browser,profile}={}) => {
    if (pipeline.running || crawlWorker) throw new Error('Pause footage preparation before changing Vimeo access.');
    if(mode==='cookies-file'){
      if(settings.vimeoAuth?.mode!=='cookies-file')throw new Error('Choose a cookies file first.');
    }else settings.vimeoAuth=VimeoAuth.normalizeVimeoAuth(mode==='browser'?{mode,browser,profile}:{mode:'none'});
    await persist();const status=vimeoAccessStatus(),retried=status.configured?pipeline.store?.retryVimeoAuthenticationRequired()||0:0;
    if(retried){pipeline.update({message:`Vimeo access saved. ${retried} verified Footage Farm screeners were queued again.`});ensureBackfill();}
    return {...status,retried};
  });
  handle('start-review', async options => {
    // A stale renderer can submit Start again while a large workspace is still
    // being opened. The requested work already exists, so resynchronize the UI
    // instead of reporting the unrelated settings-change guard.
    if (engine.running) return { alreadyRunning: true, state: engine.snapshot() };
    noRun(); if (!selectedProject) throw new Error('Choose a project folder.'); if (!secret) throw new Error('Add your OpenRouter API key in Settings.');
    starting = true;
    try {
    // Verify current model IDs and capabilities before sending any paid request.
    catalog = await API.listModels(secret);
    const primary = catalog.find(m => m.id === options.primary), secondary = options.verification ? catalog.find(m => m.id === options.secondary) : null;
    if (!primary || (options.verification && !secondary)) throw new Error('A selected model is no longer available as a vision model. Refresh the dropdown.');
    if (primary.id === secondary?.id) throw new Error('Independent verification requires two different models.');
    const budget = Number(options.budget); if (!(budget > 0 && budget <= 10000)) throw new Error('Run budget must be between $0.01 and $10,000.');
    const workers = Number(options.workers ?? 4); if (!Number.isInteger(workers) || workers < 1 || workers > 128) throw new Error('Choose between 1 and 128 review workers.');
    const videoConcurrency = Number(options.videoConcurrency ?? settings.videoConcurrency ?? 4); if (!Number.isInteger(videoConcurrency) || videoConcurrency < 1 || videoConcurrency > 16) throw new Error('Choose between 1 and 16 videos at once.');
    const dispatchMode = options.dispatchMode ?? settings.dispatchMode ?? 'one-at-a-time';
    if (!['one-at-a-time','concurrent'].includes(dispatchMode)) throw new Error('Choose Take turns or Run concurrently.');
    const verificationMode = options.verificationMode || 'positives';
    if (!['all','positives'].includes(verificationMode)) throw new Error('Choose a valid verification mode.');
    Object.assign(settings, { workers, videoConcurrency, dispatchMode, primary: primary.id, secondary: secondary?.id || options.secondary, verification: !!options.verification, verificationMode, detail: !!options.detail, budget }); await persist();
    ensureBackfill();
    engine.run({ root: selectedProject.root, sourceKey:settings.activeSource||null, key: secret, primary, secondary, verificationMode, detail: !!options.detail, budget, workers, videoConcurrency, dispatchMode, policy: activePolicy(), followPreparation: () => ({ running: pipeline.running, status: pipeline.state.status, message: pipeline.state.message }) }).catch(e => engine.update({ status: 'error', message: e.message }));
    return { started: true, state: engine.snapshot() };
    } finally { starting = false; }
  });
  handle('set-dispatch-mode', async mode => { noRun(); if (!['one-at-a-time','concurrent'].includes(mode)) throw new Error('Choose Take turns or Run concurrently.'); settings.dispatchMode=mode; await persist(); return mode; });
  handle('pause-review', () => { if (engine.running) engine.pause(); return true; });
  handle('hit-recheck-info', async () => {
    if(!selectedProject) return {...hitRecheck.snapshot(),status:'idle',message:'Choose a workspace to inspect saved hits.'};
    return hitRecheck.info(selectedProject.root,activePolicy());
  });
  handle('hit-recheck-results', async () => {
    if(!selectedProject)throw new Error('Choose a workspace first.');
    return hitRecheck.results(selectedProject.root,activePolicy());
  });
  handle('start-hit-recheck', async options => {
    noRun();if(!selectedProject)throw new Error('Choose a workspace first.');if(!secret)throw new Error('Connect OpenRouter before rechecking saved hits.');if(options?.consent!==true)throw new Error('Approve the saved-evidence upload on the Troubleshooting screen before starting.');
    const budget=Number(options?.budget),workers=Number(options?.workers);
    if(!(budget>=.01&&budget<=1000))throw new Error('Recheck budget must be $0.01–$1,000.');
    if(!Number.isInteger(workers)||workers<1||workers>32)throw new Error('Choose between 1 and 32 recheck workers.');
    starting=true;
    try{
      hitRecheck.update({status:'starting',message:'Checking model availability before any image is sent…',workers,budget});
      catalog=await API.listModels(secret);const primary=catalog.find(model=>model.id===options?.primary);
      if(!primary)throw new Error('Choose a currently available vision model on the Visual review screen first.');
      settings.catalog=catalog;settings.catalogAt=new Date().toISOString();settings.primary=primary.id;settings.recheckBudget=budget;settings.recheckWorkers=workers;await persist();
      hitRecheck.run({root:selectedProject.root,key:secret,primary,policy:activePolicy(),workers,budget}).catch(()=>{});
      return hitRecheck.snapshot();
    }catch(error){hitRecheck.update({status:'error',message:error.message});throw error;}
    finally{starting=false;}
  });
  handle('pause-hit-recheck', () => hitRecheck.pause());
  handle('clear-hit-recheck', async () => {
    noRun();if(!selectedProject)throw new Error('Choose a workspace first.');
    return hitRecheck.clear(selectedProject.root,activePolicy());
  });
  handle('open-hit-recheck-report', async () => {
    if(!selectedProject)throw new Error('Choose a workspace first.');
    const report=path.join(hitRecheck.reportDir(selectedProject.root,activePolicy().VERSION),'report.html');
    if(!await S.exists(report))throw new Error('No saved-hit recheck report is available yet.');
    const error=await shell.openPath(report);if(error)throw new Error(error);return true;
  });
  handle('feedback-reasons', () => F.REASONS.map(({ id, label }) => ({ id, label })));
  handle('get-learning', async () => {
    if(!selectedProject)throw new Error('Choose a workspace first.');
    const feedback=F.active(await F.load(selectedProject.root)),doc=await L.load(selectedProject.root);
    return { state:learner.snapshot(),lessons:L.view(doc,feedback),cases:feedback.map(f=>({id:f.id,feedback_id:f.event_id,label:f.action})),model:settings.learningModel||'',budget:settings.learningBudget||1 };
  });
  handle('start-learning', async options => {
    if(starting||learner.running||hitRecheck.running)throw new Error('A start, learning pass, or saved-hit recheck is already in progress.');
    if(!selectedProject||!secret)throw new Error('Choose a workspace and configure OpenRouter first.');
    starting=true;
    try{
      catalog=await API.listModels(secret);const model=catalog.find(m=>m.id===options.model),budget=Number(options.budget);
      if(!model)throw new Error('Choose a currently available vision learning model.');
      if(!(budget>=.01&&budget<=100))throw new Error('Learning budget must be $0.01–$100.');
      settings.learningModel=model.id;settings.learningBudget=budget;await persist();
      const root=selectedProject.root;
      const policy=activePolicy();
      learner.run({root,key:secret,model,budget,includeNotes:options.includeNotes===true,policy,beforeStart:async()=>{if(engine.running)engine.pause();while(engine.running)await new Promise(r=>setTimeout(r,200));await engine.openWorkspace(root);},applyRules:async rules=>{settings.criteria=Policy.withLearnedRules(settings.criteria,rules);await persist();}}).catch(e=>learner.update({status:'error',message:e.message}));
      return learner.snapshot();
    }finally{starting=false;}
  });
  handle('stop-learning', () => {if(learner.running)learner.pause();return true;});
  handle('set-lesson-active', async ({id,active}) => {
    if(!selectedProject||typeof id!=='string'||typeof active!=='boolean')throw new Error('Choose a saved lesson.');
    await L.setActive(selectedProject.root,id,active,async()=>F.active(await F.load(selectedProject.root)));
    send('learning-updated',true);await changed();return true;
  });
  handle('save-hit-feedback', async options => {
    if (!selectedProject) throw new Error('Choose a project first.');
    const root = selectedProject.root;
    await F.save(root, options);
    const result = await projectCounts(selectedProject);
    send('project-updated', result);
    send('learning-updated',true);
    engine.event(options.action === 'undo' ? `${options.id} · human label undone.` : options.action === 'confirmed_hit' ? `${options.id} · evidence confirmed as a true hit. Retraining will use this positive example.` : `${options.id} · evidence flagged as a false hit. Retraining will use this negative example; the saved card remains available.`);
    return result;
  });
  handle('save-bulk-hit-feedback', async options => {
    if (!selectedProject) throw new Error('Choose a project first.');
    const root = selectedProject.root;
    const saved = await F.saveMany(root, options);
    const project = await projectCounts(selectedProject);
    send('project-updated', project);
    send('learning-updated', true);
    const label = options.action === 'confirmed_hit' ? 'confirmed as true hits' : 'rejected as false hits';
    engine.event(`${saved.saved} unique evidence hit${saved.saved === 1 ? '' : 's'} bulk ${label}. Retraining will use every current label.${saved.skipped ? ` ${saved.skipped} already had the same label.` : ''}`);
    return { project, saved: saved.saved, skipped: saved.skipped };
  });
  handle('result-detail', async id => {
    if (!selectedProject || typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose a saved result.');
    const journal=await F.load(selectedProject.root);
    let entry=V.detail(selectedProject.entries,journal,id);
    if(!entry){const ledger=await S.loadLedger(selectedProject.root);entry=V.detail(ledger.entries,journal,id);}
    if(!entry)throw new Error('This saved result is no longer available. Refresh the workspace.');
    return entry;
  });
  handle('image', localImage);
  handle('match-image', matchImage);
  handle('open-project-folder', async () => { if (!selectedProject) throw new Error('Choose a project.'); return shell.openPath(selectedProject.root); });
  handle('open-review-logs', async () => {
    if (!selectedProject) throw new Error('Choose a project.');
    const folder = path.join(selectedProject.root, 'logs'); await fs.mkdir(folder, { recursive: true });
    return shell.openPath(folder);
  });
  handle('open-url', async url => { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Only web links may be opened.'); await shell.openExternal(u.href); return true; });
  handle('export', async (format, scope='hits') => {
    if(!['hits','all'].includes(scope))throw new Error('Choose hits or all results.');
    if (!selectedProject) throw new Error('Choose a project.');
    const { entries } = await S.loadLedger(selectedProject.root); const hits = F.annotate(entries, await F.load(selectedProject.root)).filter(e=>scope==='all'||F.isAcceptedHit(e));
    if (!['csv', 'json'].includes(format)) throw new Error('Unsupported export type.');
    const result = await dialog.showSaveDialog(win, { title: scope==='all'?'Export all review results':'Export strict hits', defaultPath: path.join(selectedProject.root, `reelsight_${scope}.${format}`), filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (result.canceled) return null;
    if (path.resolve(result.filePath) === path.join(selectedProject.root, 'chat_verdicts.json')) throw new Error('Choose a separate export file; do not replace the verdict ledger.');
    const cell = v => '"' + String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""') + '"';
    const fields = ['id', 'verdict', 'title', 'url', 'cues', 'summary', 'confidence', 'cards_reviewed_count', 'method', 'copied_from', 'coverage_mode'];
    const data = format === 'json' ? JSON.stringify(hits, null, 2) : '\uFEFF' + [fields.join(','), ...hits.map(e => fields.map(k => cell(e[k])).join(','))].join('\r\n');
    await fs.writeFile(result.filePath, data, 'utf8'); return { path: result.filePath, count: hits.length };
  });
  if (testMode) handle('test-open-project', openProject);
  await win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (process.env.REELSIGHT_HIDDEN !== '1') win.show();
}
if (!app.requestSingleInstanceLock() && !testMode) app.quit();
else { app.whenReady().then(createWindow).catch(e => { if(testMode)console.error(e.stack||e);else dialog.showErrorBox('Jewish Reels could not start', e.message); app.quit(); }); app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } }); }
app.on('window-all-closed', () => app.quit());
