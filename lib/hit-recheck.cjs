const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const S = require('./storage.cjs');
const F = require('./feedback.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const csv = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const terminal = value => ['confirmed_hit','rejected_by_primary','rejected_unconfirmed'].includes(value?.final);

function normalizeOutcome(value) {
  const record=clone(value);
  if(record.human_override?.status==='confirmed_hit'){
    record.model_final ||= record.final;
    record.final='confirmed_hit';record.new_decision='hit';
    return record;
  }
  const first=record.primary;
  if(!first)return record;
  record.final=first.decision==='hit'?'confirmed_hit':'rejected_by_primary';
  record.new_decision=record.final==='confirmed_hit'?'hit':'no';
  return record;
}

function cleanError(error) {
  return { message:String(error?.message || error || 'Unknown error').replace(/sk-or-[\w-]+/g,'[redacted]').slice(0,1400), code:error?.code || null, status:error?.status || null, provider:error?.provider || null, provider_message:error?.providerMessage || null, retry_kind:error?.retryKind || null, billing_uncertain:!!error?.billingUncertain };
}
function hitRegions(entry) { return Array.isArray(entry.evidence_hits) && entry.evidence_hits.length ? entry.evidence_hits : entry.evidence ? [entry.evidence] : []; }
function occurrence(entry,evidence) {
  const pick=value=>value?{decision:value.decision,cue:value.cue,evidence:value.evidence,location:value.location,confidence:value.confidence,box:value.box,model:value.model}:null;
  return { video_id:String(entry.id),copied_from:entry.copied_from||null,title:entry.title||'',url:entry.url||'',card_path:evidence.card_path||'',region:evidence.region||null,bounds:evidence.bounds||null,old_primary:pick(evidence.primary),old_secondary:pick(evidence.secondary),human_status:entry.human_review?.status||'unlabeled',human_reason:entry.human_review?.reason||'' };
}
function publicResult(result) {
  if(!result)return null;
  return {decision:result.decision,cue:result.cue,evidence:result.evidence,location:result.location,confidence:result.confidence,box:result.box,model:result.model,provider:result.provider,request_id:result.request_id,cost:result.cost,estimated:result.estimated,elapsed_ms:result.elapsed_ms,output_mode:result.output_mode};
}

class HitRecheck extends EventEmitter {
  constructor({ reviewer, account=async()=>{} }={}) {
    super();this.reviewer=reviewer;this.accountUsage=account;this.running=false;this.pauseRequested=false;this.outputModes=new Map();
    this.state={status:'idle',message:'Choose a workspace to inspect saved hits.',policy:null,sourceHitRecords:0,sourceEvidenceRows:0,uniqueImages:0,preparingCompleted:0,preparingTotal:0,completed:0,confirmed:0,rejectedPrimary:0,rejectedUnconfirmed:0,errors:0,requests:0,spend:0,workers:16,budget:10,reportAvailable:false,reportPath:null,last:null};
  }
  snapshot(){return clone(this.state);}
  update(value){Object.assign(this.state,value);this.emit('state',this.snapshot());}
  pause(){if(this.running){this.pauseRequested=true;this.update({status:'pausing',message:'Finishing and saving in-flight evidence checks…'});}return this.snapshot();}
  async info(root,policy){
    const ledger=await S.loadLedger(root),hits=ledger.entries.filter(e=>e.verdict==='jewish');
    const rows=hits.flatMap(entry=>hitRegions(entry).filter(e=>e.card_path).map(e=>({entry,evidence:e})));
    const unique=new Set(rows.map(({evidence})=>JSON.stringify([evidence.card_path,evidence.bounds||null]))).size;
    const reportDir=this.reportDir(root,policy.VERSION),saved=await S.readJson(path.join(reportDir,'results.json'),null),results=Array.isArray(saved?.results)?saved.results.map(normalizeOutcome):[];
    const summary=this.summarize(results);
    this.update({policy:policy.VERSION,sourceHitRecords:hits.length,sourceEvidenceRows:rows.length,uniqueImages:saved?.unique_images||unique,...summary,reportAvailable:await S.exists(path.join(reportDir,'report.html')),reportPath:path.join(reportDir,'report.html'),message:this.running?this.state.message:results.length?`${summary.completed} of ${saved.unique_images||unique} unique evidence images checked.`:`${unique} saved evidence images are ready to recheck.`});
    return this.snapshot();
  }
  reportDir(root,version){
    const safe=String(version||'unknown').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'unknown';
    return path.join(root,'reports',`hit-recheck-${safe}`);
  }
  async clear(root,policy){
    if(this.running)throw new Error('Pause the saved-hit recheck before clearing its scores.');
    const reportsRoot=path.resolve(root,'reports'),removed=[];
    for(const entry of await fs.readdir(reportsRoot,{withFileTypes:true}).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){
      if(!entry.isDirectory()||!entry.name.startsWith('hit-recheck-'))continue;
      const folder=path.resolve(reportsRoot,entry.name),relative=path.relative(reportsRoot,folder);
      if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Unsafe troubleshooting report path.');
      await fs.rm(folder,{recursive:true,force:true});removed.push(entry.name);
    }
    this.update({status:'idle',message:'Troubleshooting scores cleared. The saved evidence is ready to score again.',policy:policy.VERSION,completed:0,confirmed:0,rejectedPrimary:0,rejectedUnconfirmed:0,errors:0,requests:0,spend:0,reportAvailable:false,reportPath:null,last:null});
    await this.info(root,policy);
    return {...this.snapshot(),clearedReports:removed.length};
  }
  async results(root,policy){
    const preferred=this.reportDir(root,policy.VERSION),reportsRoot=path.join(root,'reports');let reportDir=preferred,saved=await S.readJson(path.join(preferred,'results.json'),null);
    if(!saved){
      const candidates=[];for(const entry of await fs.readdir(reportsRoot,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()&&entry.name.startsWith('hit-recheck-')){const folder=path.join(reportsRoot,entry.name),file=path.join(folder,'results.json');try{candidates.push({folder,mtime:(await fs.stat(file)).mtimeMs});}catch{}}
      candidates.sort((a,b)=>b.mtime-a.mtime);for(const candidate of candidates){const value=await S.readJson(path.join(candidate.folder,'results.json'),null);if(value&&Array.isArray(value.results)){reportDir=candidate.folder;saved=value;break;}}
    }
    if(!saved||!Array.isArray(saved.results))return {policy:policy.VERSION,updatedAt:null,results:[]};
    return {policy:saved.policy||policy.VERSION,updatedAt:saved.updated_at||null,results:saved.results.map(normalizeOutcome).map(value=>{
      const absolute=path.resolve(reportDir,String(value.image_file||'')),relative=path.relative(reportDir,absolute);
      const safeImage=!relative.startsWith('..')&&!path.isAbsolute(relative)&&/^images[\\/].+\.jpe?g$/i.test(relative);
      return {...clone(value),image_path:safeImage?path.relative(root,absolute):null};
    })};
  }
  summarize(results){
    const count=name=>results.filter(value=>value.final===name).length;
    return {completed:results.filter(terminal).length,confirmed:count('confirmed_hit'),rejectedPrimary:count('rejected_by_primary'),rejectedUnconfirmed:count('rejected_unconfirmed'),errors:count('error')};
  }
  async prepare(root,reportDir,entries,onProgress=()=>{}){
    const imagesDir=path.join(reportDir,'images');await fs.mkdir(imagesDir,{recursive:true});
    const annotated=F.annotate(entries,await F.load(root)),candidates=[];
    for(const entry of annotated.filter(value=>value.verdict==='jewish'))for(const evidence of hitRegions(entry))if(evidence.card_path)candidates.push({entry,evidence,occurrence:occurrence(entry,evidence)});
    candidates.sort((a,b)=>a.occurrence.video_id.localeCompare(b.occurrence.video_id,'en',{numeric:true})||a.occurrence.card_path.localeCompare(b.occurrence.card_path,'en',{numeric:true})||(a.occurrence.region||0)-(b.occurrence.region||0));
    let completed=0,cursor=0;const prepared=new Array(candidates.length);onProgress({completed,total:candidates.length});
    const worker=async()=>{for(;;){const index=cursor++;if(index>=candidates.length)return;const candidate=candidates[index];
      const source=path.resolve(root,candidate.evidence.card_path),rel=path.relative(root,source);
      if(rel.startsWith('..')||path.isAbsolute(rel)||!/\.jpe?g$/i.test(source))throw new Error(`Unsafe evidence path for ${candidate.entry.id}.`);
      const image=sharp(source),metadata=await image.metadata(),raw=candidate.evidence.bounds||{x:0,y:0,width:metadata.width,height:metadata.height};
      const bounds={x:Number(raw.x),y:Number(raw.y),width:Number(raw.width),height:Number(raw.height)};
      if(!Number.isInteger(bounds.x)||!Number.isInteger(bounds.y)||!Number.isInteger(bounds.width)||!Number.isInteger(bounds.height)||bounds.x<0||bounds.y<0||bounds.width<1||bounds.height<1||bounds.x+bounds.width>metadata.width||bounds.y+bounds.height>metadata.height)throw new Error(`Invalid saved evidence bounds for ${candidate.entry.id}.`);
      const pixels=await image.extract({left:bounds.x,top:bounds.y,width:bounds.width,height:bounds.height}).jpeg({quality:92}).toBuffer(),digest=sha(pixels),destination=path.join(imagesDir,`${digest}.jpg`);
      try{await fs.writeFile(destination,pixels,{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
      prepared[index]={candidate,digest,width:bounds.width,height:bounds.height,image_file:path.join('images',`${digest}.jpg`)};
      completed++;if(completed===candidates.length||completed%4===0)onProgress({completed,total:candidates.length});
    }};
    await Promise.all(Array.from({length:Math.min(8,candidates.length||1)},()=>worker()));
    const grouped=new Map();let sequence=0;
    for(const value of prepared){
      const {candidate,digest,width,height,image_file}=value;
      let item=grouped.get(digest);
      if(!item){
        sequence++;item={index:sequence,image_sha256:digest,image_file,width,height,occurrences:[]};grouped.set(digest,item);
      }
      item.occurrences.push(candidate.occurrence);
    }
    return {candidates:candidates.length,items:[...grouped.values()]};
  }
  async image(reportDir,item){
    const buffer=await fs.readFile(path.join(reportDir,item.image_file));
    return {mime:'image/jpeg',data:buffer.toString('base64'),bounds:{x:0,y:0,width:item.width,height:item.height},imageSize:{width:item.width,height:item.height}};
  }
  async run({root,key,primary,policy,workers=16,budget=10}){
    if(this.running)throw new Error('A saved-hit recheck is already running.');
    if(!key)throw new Error('Connect OpenRouter before rechecking saved hits.');
    if(!primary?.id)throw new Error('Choose an image-review model.');
    if(!Number.isInteger(workers)||workers<1||workers>32)throw new Error('Choose between 1 and 32 recheck workers.');
    if(!Number.isFinite(budget)||budget<=0)throw new Error('Enter a positive recheck budget.');
    this.running=true;this.pauseRequested=false;this.fatal=null;this.outputModes=new Map();
    const reportDir=this.reportDir(root,policy.VERSION),liveFile=path.join(reportDir,'live.json'),startedAt=new Date().toISOString();
    try{
      await fs.mkdir(reportDir,{recursive:true});
      await S.atomicJson(liveFile,{version:1,status:'preparing',started_at:startedAt,updated_at:startedAt,policy:policy.VERSION,workers,budget,source_hit_records:0,source_evidence_rows:0,prepared_rows:0,unique_images:0,completed:0,requests:0,spend:0});
      this.update({status:'preparing',message:'Preparing and deduplicating saved evidence images…',policy:policy.VERSION,workers,budget,spend:0,requests:0,reportAvailable:false,reportPath:path.join(reportDir,'report.html')});
      const ledger=await S.loadLedger(root),sourceHitRecords=ledger.entries.filter(e=>e.verdict==='jewish').length;
      const prepared=await this.prepare(root,reportDir,ledger.entries,progress=>this.update({status:'preparing',message:`Preparing ${progress.completed} of ${progress.total} saved evidence rows…`,sourceHitRecords,sourceEvidenceRows:progress.total,preparingCompleted:progress.completed,preparingTotal:progress.total}));
      const feedbackContext=await F.workspaceContext(root),resultFile=path.join(reportDir,'results.json'),transportFile=path.join(reportDir,'transport.jsonl');
      const old=await S.readJson(resultFile,null),state=old?.version===1&&old.policy===policy.VERSION?old:{version:1,started_at:new Date().toISOString(),updated_at:new Date().toISOString(),completed_at:null,policy:policy.VERSION,primary_model:primary.id,secondary_model:null,verification_mode:'single',source_hit_records:ledger.entries.filter(e=>e.verdict==='jewish').length,source_evidence_rows:prepared.candidates,unique_images:prepared.items.length,feedback_revision:feedbackContext.revision||null,spend:0,requests:0,results:[]};
      state.primary_model=primary.id;state.secondary_model=null;state.verification_mode='single';state.unique_images=prepared.items.length;state.source_evidence_rows=prepared.candidates;
      const records=new Map(state.results.map(value=>[value.image_sha256,normalizeOutcome(value)]));let saveChain=Promise.resolve(),cursor=0;
      const persist=()=>{const snapshot=clone({...state,updated_at:new Date().toISOString(),results:[...records.values()].sort((a,b)=>a.index-b.index)});saveChain=saveChain.catch(()=>{}).then(()=>S.atomicJson(resultFile,snapshot));return saveChain;};
      const diagnostic=(item,role,record)=>fs.appendFile(transportFile,JSON.stringify({at:new Date().toISOString(),image_index:item.index,image_sha256:item.image_sha256,role,...record})+'\n');
      const account=async value=>{const data=value?.accounting||value,cost=Number(data?.cost);if(Number.isFinite(cost))state.spend+=cost;state.requests++;await this.accountUsage(data);};
      const budgetReached=()=>state.spend>=budget;
      const invoke=async(item,model,role,image)=>{
        let rate=0,invalid=0,transient=0,fallbacks=0,formatMode=this.outputModes.get(model.id),formatIssue;
        for(;;){
          if(this.pauseRequested||budgetReached())return null;
          try{const result=await this.reviewer({key,model,image,policy,feedbackContext,formatMode,formatRetry:invalid>0,formatIssue,onDiagnostic:record=>diagnostic(item,role,record)});await account(result);if(formatMode)this.outputModes.set(model.id,formatMode);return result;}
          catch(error){
            if(error.accounting)await account(error.accounting);await diagnostic(item,role,{event:'recheck_retry',error:cleanError(error),invalid_retries:invalid,transient_retries:transient,rate_retries:rate});
            if(error.code==='OUTPUT_FORMAT_UNSUPPORTED'&&fallbacks<2&&['json','prompt'].includes(error.fallbackMode)){formatMode=error.fallbackMode;this.outputModes.set(model.id,formatMode);fallbacks++;continue;}
            if(error.code==='INVALID_VISUAL_RESULT'&&invalid<2){invalid++;formatIssue=error.validationIssue;continue;}
            if(error.status===429&&rate<6){const delay=Math.min(60000,Math.max(error.retryAfterMs||0,2000*2**rate));rate++;await sleep(delay);continue;}
            if(error.transient&&transient<3){const delay=Math.min(30000,Math.max(error.retryAfterMs||0,2000*2**transient));transient++;await sleep(delay);continue;}
            throw error;
          }
        }
      };
      const tasks=prepared.items.filter(item=>!terminal(records.get(item.image_sha256)));
      await S.atomicJson(liveFile,{version:1,status:'running',started_at:startedAt,updated_at:new Date().toISOString(),policy:policy.VERSION,workers,budget,source_hit_records:state.source_hit_records,source_evidence_rows:state.source_evidence_rows,prepared_rows:state.source_evidence_rows,unique_images:state.unique_images,completed:this.summarize([...records.values()]).completed,requests:state.requests,spend:state.spend});
      this.update({status:'running',message:`Rechecking ${tasks.length} saved evidence images…`,policy:policy.VERSION,sourceHitRecords:state.source_hit_records,sourceEvidenceRows:state.source_evidence_rows,uniqueImages:state.unique_images,preparingCompleted:state.source_evidence_rows,preparingTotal:state.source_evidence_rows,workers,budget,spend:state.spend,requests:state.requests,...this.summarize([...records.values()]),reportPath:path.join(reportDir,'report.html')});
      const worker=async()=>{for(;;){
        if(this.pauseRequested||budgetReached()||this.fatal)return;const position=cursor++;if(position>=tasks.length)return;const item=tasks[position],existing=records.get(item.image_sha256),image=await this.image(reportDir,item);let record;
        try{
          const first=existing?.primary||await invoke(item,primary,'primary',image);if(!first){if(existing)records.set(item.image_sha256,{...existing,occurrences:item.occurrences});await persist();return;}
          const final=first.decision==='hit'?'confirmed_hit':'rejected_by_primary';
          record={index:item.index,image_sha256:item.image_sha256,image_file:item.image_file,width:item.width,height:item.height,occurrences:item.occurrences,final,new_decision:final==='confirmed_hit'?'hit':'no',primary:publicResult(first),secondary:null,checked_at:new Date().toISOString()};
        }catch(error){record={index:item.index,image_sha256:item.image_sha256,image_file:item.image_file,width:item.width,height:item.height,occurrences:item.occurrences,final:'error',new_decision:'error',error:cleanError(error),checked_at:new Date().toISOString()};if([401,402].includes(error.status))this.fatal=error;}
        records.set(item.image_sha256,record);await persist();const summary=this.summarize([...records.values()]);this.update({...summary,spend:state.spend,requests:state.requests,last:{index:item.index,final:record.final,video_ids:item.occurrences.map(value=>value.video_id),primary:record.primary?.cue||null,secondary:record.secondary?.cue||null},message:`${summary.completed} of ${prepared.items.length} unique evidence images checked.`});
      }};
      await Promise.all(Array.from({length:Math.min(workers,tasks.length||1)},()=>worker()));await saveChain;
      state.results=[...records.values()].sort((a,b)=>a.index-b.index);const summary=this.summarize(state.results),done=summary.completed===prepared.items.length;
      state.completed_at=done?new Date().toISOString():null;await S.atomicJson(resultFile,state);await writeReports(reportDir,state);
      if(this.fatal)throw this.fatal;
      const paused=this.pauseRequested||budgetReached();this.update({...summary,status:done?'complete':'paused',message:done?'Saved-hit recheck complete. Open the image-by-image report.':budgetReached()?'Recheck budget reached. Raise the budget and resume to continue.':'Saved-hit recheck paused. Resume to continue.',spend:state.spend,requests:state.requests,reportAvailable:true,reportPath:path.join(reportDir,'report.html')});
      await S.atomicJson(liveFile,{version:1,status:done?'complete':'paused',started_at:startedAt,updated_at:new Date().toISOString(),policy:policy.VERSION,workers,budget,source_hit_records:state.source_hit_records,source_evidence_rows:state.source_evidence_rows,prepared_rows:state.source_evidence_rows,unique_images:state.unique_images,completed:summary.completed,confirmed:summary.confirmed,rejected_primary:summary.rejectedPrimary,rejected_unconfirmed:summary.rejectedUnconfirmed,errors:summary.errors,requests:state.requests,spend:state.spend});
    }catch(error){const cleaned=cleanError(error);await fs.mkdir(reportDir,{recursive:true}).then(()=>S.atomicJson(liveFile,{version:1,status:'error',started_at:startedAt,updated_at:new Date().toISOString(),policy:policy.VERSION,workers,budget,error:cleaned})).catch(()=>{});this.update({status:'error',message:cleaned.message,reportAvailable:!!this.state.reportPath&&await S.exists(this.state.reportPath)});throw error;}
    finally{this.running=false;this.pauseRequested=false;this.emit('finished',this.snapshot());}
    return this.snapshot();
  }
}

async function writeReports(reportDir,state){
  const rows=['image_index,image_file,video_ids,human_statuses,old_cues,new_decision,final,primary_cue,primary_evidence,secondary_cue,secondary_evidence,error'];
  for(const item of state.results)rows.push([item.index,item.image_file,item.occurrences.map(o=>o.video_id).join(' | '),item.occurrences.map(o=>o.human_status).join(' | '),item.occurrences.map(o=>o.old_primary?.cue||'').join(' | '),item.new_decision,item.final,item.primary?.cue||'',item.primary?.evidence||'',item.secondary?.cue||'',item.secondary?.evidence||'',item.error?.message||''].map(csv).join(','));
  await fs.writeFile(path.join(reportDir,'report.csv'),rows.join('\r\n')+'\r\n');
  const count=name=>state.results.filter(value=>value.final===name).length;
  const cards=state.results.map(item=>{const people=item.occurrences.map(o=>`<li><strong>${esc(o.video_id)}</strong>${o.copied_from?` <span class="muted">copy of ${esc(o.copied_from)}</span>`:''} · ${esc(o.card_path)}${o.human_status!=='unlabeled'?` · <span class="human">${esc(o.human_status)}: ${esc(o.human_reason)}</span>`:''}<br><span class="muted">Old ${esc(o.old_primary?.cue||'unknown')}: ${esc(o.old_primary?.evidence||'')}</span></li>`).join(''),primary=item.primary?`<p><strong>Reviewer · ${esc(item.primary.model||state.primary_model)} · ${esc(item.primary.decision)} / ${esc(item.primary.cue)}</strong><br>${esc(item.primary.evidence)}${item.primary.location?`<br><span class="muted">${esc(item.primary.location)} · confidence ${esc(item.primary.confidence)}</span>`:''}</p>`:'',error=item.error?`<p class="error"><strong>Error:</strong> ${esc(item.error.message)}</p>`:'';return `<article class="card ${esc(item.final)}"><div class="image"><span class="number">${item.index}</span><img src="${encodeURI(item.image_file.replace(/\\/g,'/'))}" alt="Evidence image ${item.index}" loading="lazy"></div><div class="body"><div class="status">${esc(item.final.replaceAll('_',' '))}</div><h2>Image ${item.index} · ${esc(item.occurrences.map(o=>o.video_id).join(', '))}</h2><ul>${people}</ul>${primary}${error}</div></article>`;}).join('\n');
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Jewish Reels saved-hit recheck</title><style>:root{--ink:#251713;--paper:#f7f0e4;--wine:#6d1d2a;--green:#2f6d53;--red:#a03939;--line:#d8c9b3}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 Georgia,serif}.wrap{max-width:1420px;margin:auto;padding:28px}header{border-bottom:3px double var(--wine);padding-bottom:18px;margin-bottom:24px}h1{margin:0;color:var(--wine);font-size:34px}.summary{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.pill,.status{border:1px solid var(--line);background:#fff9ef;padding:5px 9px;border-radius:99px;font:700 12px/1.2 Arial,sans-serif;text-transform:uppercase}.card{display:grid;grid-template-columns:minmax(320px,44%) 1fr;background:#fffaf2;border:1px solid var(--line);box-shadow:0 5px 18px #3d25151c;margin:0 0 22px;overflow:hidden;border-radius:10px}.image{position:relative;background:#17120f;min-height:300px;display:grid;place-items:center}.image img{display:block;max-width:100%;max-height:640px}.number{position:absolute;top:10px;left:10px;background:#000b;color:#fff;border-radius:6px;padding:5px 8px;font:bold 13px Arial}.body{padding:22px}.body h2{margin:9px 0 12px;color:var(--wine)}.muted{color:#685d54}.human{color:var(--wine);font-weight:bold}.confirmed_hit .status{color:var(--green)}.rejected_by_primary .status,.error{color:var(--red)}@media(max-width:850px){.card{grid-template-columns:1fr}.wrap{padding:14px}}</style></head><body><div class="wrap"><header><h1>Saved-hit recheck · ${esc(state.policy)}</h1><p>Each distinct saved evidence image was re-read once by ${esc(state.primary_model)} without its title, URL, previous claim, or human label. That reviewer’s answer is the saved result.</p><div class="summary"><span class="pill">${state.unique_images} unique images</span><span class="pill">${state.source_evidence_rows} evidence rows</span><span class="pill">${count('confirmed_hit')} confirmed hits</span><span class="pill">${count('rejected_by_primary')} reviewer no</span><span class="pill">${count('error')} errors</span><span class="pill">${state.requests} requests · $${Number(state.spend||0).toFixed(4)}</span></div></header>${cards}</div></body></html>`;
  await fs.writeFile(path.join(reportDir,'report.html'),html);await S.atomicJson(path.join(reportDir,'results.json'),state);
}

module.exports={HitRecheck,writeReports,hitRegions,cleanError};
