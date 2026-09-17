const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const S = require('../lib/storage.cjs');
const F = require('../lib/feedback.cjs');
const API = require('../lib/openrouter.cjs');
const Policy = require('../lib/policy.cjs');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(app.getPath('appData'), 'ReelSight'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const cleanError = error => ({
  message: String(error?.message || error || 'Unknown error').replace(/sk-or-[\w-]+/g, '[redacted]').slice(0, 1400),
  code: error?.code || null,
  status: error?.status || null,
  provider: error?.provider || null,
  provider_message: error?.providerMessage || null,
  retry_kind: error?.retryKind || null,
  billing_uncertain: !!error?.billingUncertain
});
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const jsonClone = value => JSON.parse(JSON.stringify(value));

async function atomicJson(filename, value) {
  await S.atomicJson(filename, value);
}

async function loadSecret(settings) {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  if (!settings.encryptedKey) throw new Error('No saved OpenRouter key is available.');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows secure storage is unavailable.');
  return safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
}

function hitRegions(entry) {
  if (Array.isArray(entry.evidence_hits) && entry.evidence_hits.length) return entry.evidence_hits;
  return entry.evidence ? [entry.evidence] : [];
}

function occurrence(entry, evidence) {
  return {
    video_id: String(entry.id),
    copied_from: entry.copied_from || null,
    title: entry.title || '',
    url: entry.url || '',
    card_path: evidence.card_path || '',
    region: evidence.region || null,
    bounds: evidence.bounds || null,
    old_primary: evidence.primary ? {
      decision: evidence.primary.decision,
      cue: evidence.primary.cue,
      evidence: evidence.primary.evidence,
      location: evidence.primary.location,
      confidence: evidence.primary.confidence,
      box: evidence.primary.box,
      model: evidence.primary.model
    } : null,
    old_secondary: evidence.secondary ? {
      decision: evidence.secondary.decision,
      cue: evidence.secondary.cue,
      evidence: evidence.secondary.evidence,
      location: evidence.secondary.location,
      confidence: evidence.secondary.confidence,
      box: evidence.secondary.box,
      model: evidence.secondary.model
    } : null,
    human_status: entry.human_review?.status || 'unlabeled',
    human_reason: entry.human_review?.reason || ''
  };
}

async function prepareEvidence(root, reportDir, entries) {
  const imagesDir = path.join(reportDir, 'images');
  await fs.mkdir(imagesDir, { recursive: true });
  const annotated = F.annotate(entries, await F.load(root));
  const candidates = [];
  for (const entry of annotated.filter(value => value.verdict === 'jewish')) {
    for (const evidence of hitRegions(entry)) {
      if (!evidence.card_path) continue;
      candidates.push({ entry, evidence, occurrence: occurrence(entry, evidence) });
    }
  }
  candidates.sort((a,b) => a.occurrence.video_id.localeCompare(b.occurrence.video_id, 'en', {numeric:true}) || a.occurrence.card_path.localeCompare(b.occurrence.card_path, 'en', {numeric:true}) || (a.occurrence.region || 0) - (b.occurrence.region || 0));
  const grouped = new Map();
  let sequence = 0;
  for (const candidate of candidates) {
    const source = path.resolve(root, candidate.evidence.card_path);
    const rel = path.relative(root, source);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !/\.jpe?g$/i.test(source)) throw new Error(`Unsafe evidence path for ${candidate.entry.id}.`);
    const metadata = await sharp(source).metadata();
    const fallback = { x:0, y:0, width:metadata.width, height:metadata.height };
    const raw = candidate.evidence.bounds || fallback;
    const bounds = { x:Number(raw.x), y:Number(raw.y), width:Number(raw.width), height:Number(raw.height) };
    if (!Number.isInteger(bounds.x) || !Number.isInteger(bounds.y) || !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) || bounds.x < 0 || bounds.y < 0 || bounds.width < 1 || bounds.height < 1 || bounds.x + bounds.width > metadata.width || bounds.y + bounds.height > metadata.height) throw new Error(`Invalid saved evidence bounds for ${candidate.entry.id}.`);
    const pixels = await sharp(source).extract({ left:bounds.x, top:bounds.y, width:bounds.width, height:bounds.height }).jpeg({ quality:92 }).toBuffer();
    const digest = sha(pixels);
    let item = grouped.get(digest);
    if (!item) {
      sequence++;
      const basename = `${String(sequence).padStart(3,'0')}-${candidate.entry.id}-${path.basename(source, path.extname(source))}.jpg`.replace(/[^a-zA-Z0-9._-]/g,'_');
      await fs.writeFile(path.join(imagesDir, basename), pixels);
      item = {
        index: sequence,
        image_sha256: digest,
        image_file: path.join('images', basename),
        width: bounds.width,
        height: bounds.height,
        image: { mime:'image/jpeg', data:pixels.toString('base64'), bounds:{x:0,y:0,width:bounds.width,height:bounds.height}, imageSize:{width:bounds.width,height:bounds.height} },
        occurrences: []
      };
      grouped.set(digest, item);
    }
    item.occurrences.push(candidate.occurrence);
  }
  return { candidates:candidates.length, items:[...grouped.values()] };
}

function publicResult(result) {
  if (!result) return null;
  return {
    decision: result.decision,
    cue: result.cue,
    evidence: result.evidence,
    location: result.location,
    confidence: result.confidence,
    box: result.box,
    model: result.model,
    provider: result.provider,
    request_id: result.request_id,
    cost: result.cost,
    estimated: result.estimated,
    elapsed_ms: result.elapsed_ms,
    output_mode: result.output_mode
  };
}

async function run() {
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  const root = await fs.realpath(settings.folder || path.resolve(__dirname, '../../outputs/Footage Workspace'));
  const secret = await loadSecret(settings);
  const policy = Policy.compile();
  if (policy.VERSION !== 'strict-visual-6') throw new Error(`Expected strict-visual-6, received ${policy.VERSION}.`);
  const catalog = Array.isArray(settings.catalog) ? settings.catalog : [];
  const primary = catalog.find(model => model.id === settings.primary);
  const secondary = settings.verification === false ? null : catalog.find(model => model.id === settings.secondary);
  if (!primary) throw new Error(`Primary model ${settings.primary || '(none)'} is not in the saved catalog.`);
  if (!secondary) throw new Error(`Independent verification model ${settings.secondary || '(none)'} is not available.`);

  const reportDir = path.join(root, 'reports', 'hit-recheck-strict-visual-6-2026-09-16');
  await fs.mkdir(reportDir, { recursive:true });
  const resultFile = path.join(reportDir, 'results.json');
  const transportFile = path.join(reportDir, 'transport.jsonl');
  const ledger = await S.loadLedger(root);
  const prepared = await prepareEvidence(root, reportDir, ledger.entries);
  const feedbackContext = await F.workspaceContext(root);
  const saved = await S.readJson(resultFile, null);
  const state = saved?.version === 1 && saved.policy === policy.VERSION ? saved : {
    version:1,
    started_at:new Date().toISOString(),
    updated_at:new Date().toISOString(),
    completed_at:null,
    policy:policy.VERSION,
    primary_model:primary.id,
    secondary_model:secondary.id,
    verification_mode:'positives',
    source_hit_records:ledger.entries.filter(entry => entry.verdict === 'jewish').length,
    source_evidence_rows:prepared.candidates,
    unique_images:prepared.items.length,
    feedback_revision:feedbackContext.revision || null,
    spend:0,
    requests:0,
    results:[]
  };
  const completed = new Map(state.results.map(value => [value.image_sha256, value]));
  const outputModes = new Map();
  let saveChain = Promise.resolve();
  const save = () => {
    const snapshot = jsonClone({ ...state, updated_at:new Date().toISOString(), results:[...completed.values()].sort((a,b)=>a.index-b.index) });
    saveChain = saveChain.catch(()=>{}).then(() => atomicJson(resultFile, snapshot));
    return saveChain;
  };
  const diagnostic = async (item, role, record) => {
    await fs.appendFile(transportFile, JSON.stringify({ at:new Date().toISOString(), image_index:item.index, image_sha256:item.image_sha256, role, ...record })+'\n');
  };
  const account = value => {
    const cost = Number(value?.cost ?? value?.accounting?.cost);
    if (Number.isFinite(cost)) state.spend += cost;
    state.requests++;
  };
  const invoke = async (item, model, role) => {
    let rateRetries=0, invalidRetries=0, transientRetries=0, fallbacks=0, formatMode=outputModes.get(model.id), formatIssue;
    for (;;) {
      try {
        const result = await API.reviewImage({ key:secret, model, image:item.image, policy, feedbackContext, formatMode, formatRetry:invalidRetries>0, formatIssue, onDiagnostic: record => diagnostic(item,role,record) });
        account(result);
        if (formatMode) outputModes.set(model.id,formatMode);
        return result;
      } catch (error) {
        if (error.accounting) account(error.accounting);
        await diagnostic(item,role,{ event:'audit_retry_decision', error:cleanError(error), invalid_retries:invalidRetries, transient_retries:transientRetries, rate_retries:rateRetries });
        if (error.code === 'OUTPUT_FORMAT_UNSUPPORTED' && fallbacks < 2 && ['json','prompt'].includes(error.fallbackMode)) {
          formatMode=error.fallbackMode; outputModes.set(model.id,formatMode); fallbacks++; continue;
        }
        if (error.code === 'INVALID_VISUAL_RESULT' && invalidRetries < 2) {
          invalidRetries++; formatIssue=error.validationIssue; continue;
        }
        if (error.status === 429 && rateRetries < 6) {
          const delay=Math.min(60000,Math.max(error.retryAfterMs||0,2000*2**rateRetries));rateRetries++;await sleep(delay);continue;
        }
        if (error.transient && transientRetries < 3) {
          const delay=Math.min(30000,Math.max(error.retryAfterMs||0,2000*2**transientRetries));transientRetries++;await sleep(delay);continue;
        }
        throw error;
      }
    }
  };

  const pending = prepared.items.filter(item => !completed.has(item.image_sha256));
  const concurrency = Math.min(16, Math.max(1, Number(settings.videoConcurrency || 8) * 2), pending.length || 1);
  console.log(`Rechecking ${prepared.items.length} unique images (${pending.length} pending) with ${primary.id} + ${secondary.id}; concurrency ${concurrency}.`);
  let cursor=0;
  const worker = async () => {
    for (;;) {
      const position=cursor++;
      if(position>=pending.length)return;
      const item=pending[position];
      let record;
      try {
        const first=await invoke(item,primary,'primary');
        let second=null,final;
        if(first.decision==='hit'){
          second=await invoke(item,secondary,'secondary');
          final=policy.corroborates(first,second)?'confirmed_hit':'rejected_unconfirmed';
        }else final='rejected_by_primary';
        record={ index:item.index,image_sha256:item.image_sha256,image_file:item.image_file,width:item.width,height:item.height,occurrences:item.occurrences,final,new_decision:final==='confirmed_hit'?'hit':'no',primary:publicResult(first),secondary:publicResult(second),checked_at:new Date().toISOString() };
      }catch(error){
        record={ index:item.index,image_sha256:item.image_sha256,image_file:item.image_file,width:item.width,height:item.height,occurrences:item.occurrences,final:'error',new_decision:'error',error:cleanError(error),checked_at:new Date().toISOString() };
      }
      completed.set(item.image_sha256,record);
      await save();
      const counts=[...completed.values()].reduce((out,value)=>(out[value.final]=(out[value.final]||0)+1,out),{});
      console.log(`[${completed.size}/${prepared.items.length}] image ${item.index}: ${record.final} · ${item.occurrences.map(value=>value.video_id).join(', ')} · spend $${state.spend.toFixed(4)} · ${JSON.stringify(counts)}`);
    }
  };
  await Promise.all(Array.from({length:concurrency},()=>worker()));
  await saveChain;
  state.completed_at=new Date().toISOString();
  const ordered=[...completed.values()].sort((a,b)=>a.index-b.index);
  state.results=ordered;
  await atomicJson(resultFile,state);
  await writeReports(reportDir,state);
  const summary=ordered.reduce((out,value)=>(out[value.final]=(out[value.final]||0)+1,out),{});
  console.log(`Complete: ${JSON.stringify(summary)}; ${state.requests} requests; $${state.spend.toFixed(4)}. Report: ${path.join(reportDir,'report.html')}`);
}

async function writeReports(reportDir,state){
  const rows=['image_index,image_file,video_ids,human_statuses,old_cues,new_decision,final,primary_cue,primary_evidence,secondary_cue,secondary_evidence,error'];
  for(const item of state.results){
    rows.push([
      item.index,item.image_file,item.occurrences.map(o=>o.video_id).join(' | '),item.occurrences.map(o=>o.human_status).join(' | '),item.occurrences.map(o=>o.old_primary?.cue||'').join(' | '),item.new_decision,item.final,item.primary?.cue||'',item.primary?.evidence||'',item.secondary?.cue||'',item.secondary?.evidence||'',item.error?.message||''
    ].map(csv).join(','));
  }
  await fs.writeFile(path.join(reportDir,'report.csv'),rows.join('\r\n')+'\r\n');
  const counts=state.results.reduce((out,value)=>(out[value.final]=(out[value.final]||0)+1,out),{});
  const cards=state.results.map(item=>{
    const people=item.occurrences.map(o=>`<li><strong>${esc(o.video_id)}</strong>${o.copied_from?` <span class="muted">copy of ${esc(o.copied_from)}</span>`:''} · ${esc(o.card_path)}${o.human_status!=='unlabeled'?` · <span class="human">${esc(o.human_status)}: ${esc(o.human_reason)}</span>`:''}<br><span class="muted">Old ${esc(o.old_primary?.cue||'unknown')}: ${esc(o.old_primary?.evidence||'')}</span></li>`).join('');
    const primary=item.primary?`<p><strong>Primary · ${esc(item.primary.model||state.primary_model)} · ${esc(item.primary.decision)} / ${esc(item.primary.cue)}</strong><br>${esc(item.primary.evidence)}${item.primary.location?`<br><span class="muted">${esc(item.primary.location)} · confidence ${esc(item.primary.confidence)}</span>`:''}</p>`:'';
    const secondary=item.secondary?`<p><strong>Verification · ${esc(item.secondary.model||state.secondary_model)} · ${esc(item.secondary.decision)} / ${esc(item.secondary.cue)}</strong><br>${esc(item.secondary.evidence)}${item.secondary.location?`<br><span class="muted">${esc(item.secondary.location)} · confidence ${esc(item.secondary.confidence)}</span>`:''}</p>`:'';
    const error=item.error?`<p class="error"><strong>Error:</strong> ${esc(item.error.message)}</p>`:'';
    return `<article class="card ${esc(item.final)}"><div class="image"><span class="number">${item.index}</span><img src="${encodeURI(item.image_file.replace(/\\/g,'/'))}" alt="Evidence image ${item.index}" loading="lazy"></div><div class="body"><div class="status">${esc(item.final.replaceAll('_',' '))}</div><h2>Image ${item.index} · ${esc(item.occurrences.map(o=>o.video_id).join(', '))}</h2><ul>${people}</ul>${primary}${secondary}${error}</div></article>`;
  }).join('\n');
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jewish Reels saved-hit recheck</title><style>
  :root{--ink:#251713;--paper:#f7f0e4;--wine:#6d1d2a;--gold:#bd8c2d;--green:#2f6d53;--red:#a03939;--line:#d8c9b3}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 Georgia,serif}.wrap{max-width:1420px;margin:auto;padding:28px}header{border-bottom:3px double var(--wine);padding-bottom:18px;margin-bottom:24px}h1{margin:0;color:var(--wine);font-size:34px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.pill,.status{border:1px solid var(--line);background:#fff9ef;padding:5px 9px;border-radius:99px;font:700 12px/1.2 Arial,sans-serif;text-transform:uppercase;letter-spacing:.04em}.card{display:grid;grid-template-columns:minmax(320px,44%) 1fr;background:#fffaf2;border:1px solid var(--line);box-shadow:0 5px 18px #3d25151c;margin:0 0 22px;overflow:hidden;border-radius:10px}.image{position:relative;background:#17120f;min-height:300px;display:grid;place-items:center}.image img{display:block;max-width:100%;max-height:640px}.number{position:absolute;top:10px;left:10px;background:#000b;color:#fff;border-radius:6px;padding:5px 8px;font:bold 13px Arial}.body{padding:22px}.body h2{margin:9px 0 12px;color:var(--wine)}ul{padding-left:20px}.muted{color:#685d54}.human{color:var(--wine);font-weight:bold}.confirmed_hit .status{color:var(--green);border-color:#8bb3a1}.rejected_by_primary .status,.rejected_unconfirmed .status{color:var(--red);border-color:#d8a4a4}.error{color:var(--red)}@media(max-width:850px){.card{grid-template-columns:1fr}.wrap{padding:14px}}
  </style></head><body><div class="wrap"><header><h1>Saved-hit recheck · ${esc(state.policy)}</h1><p>Each distinct saved evidence image was re-read without its title, URL, previous claim, or human label. A positive required ${esc(state.primary_model)} and independent verification by ${esc(state.secondary_model)} on the same cue and overlapping pixels.</p><div class="summary"><span class="pill">${state.unique_images} unique images</span><span class="pill">${state.source_evidence_rows} evidence rows</span><span class="pill">${counts.confirmed_hit||0} confirmed hits</span><span class="pill">${counts.rejected_by_primary||0} primary no</span><span class="pill">${counts.rejected_unconfirmed||0} unconfirmed</span><span class="pill">${counts.error||0} errors</span><span class="pill">${state.requests} requests · $${Number(state.spend||0).toFixed(4)}</span></div></header>${cards}</div></body></html>`;
  await fs.writeFile(path.join(reportDir,'report.html'),html);
}

app.whenReady().then(run).then(()=>app.quit()).catch(error=>{console.error(cleanError(error));process.exitCode=1;app.quit();});
