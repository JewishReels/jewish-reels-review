let recheckState={status:'idle',uniqueImages:0,completed:0,confirmed:0,rejectedPrimary:0,rejectedUnconfirmed:0,errors:0,requests:0,spend:0};

function renderRecheck(state={}){
  recheckState={...recheckState,...state};const s=recheckState,total=Number(s.uniqueImages||0),done=Number(s.completed||0),preparing=s.status==='preparing',progressTotal=preparing?Number(s.preparingTotal||s.sourceEvidenceRows||0):total,progressDone=preparing?Number(s.preparingCompleted||0):done,pct=progressTotal?Math.min(100,Math.round(progressDone/progressTotal*100)):0,busy=['starting','preparing','running','pausing'].includes(s.status),pausable=['preparing','running','pausing'].includes(s.status);
  window.recheckBusy=busy;
  $('recheckHitRecords').textContent=Number(s.sourceHitRecords||0).toLocaleString();$('recheckEvidenceRows').textContent=Number(s.sourceEvidenceRows||0).toLocaleString();$('recheckUniqueImages').textContent=total.toLocaleString();$('recheckPolicy').textContent=s.policy||'—';
  $('recheckConfirmed').textContent=Number(s.confirmed||0).toLocaleString();$('recheckPrimaryNo').textContent=Number(s.rejectedPrimary||0).toLocaleString();$('recheckErrors').textContent=Number(s.errors||0).toLocaleString();
  $('recheckFill').style.width=pct+'%';$('recheckPercent').textContent=pct+'%';document.querySelector('.recheck-progress .progress-track').setAttribute('aria-valuenow',pct);$('recheckMessage').textContent=s.message||'Ready.';$('recheckDetail').textContent=preparing?`${progressDone.toLocaleString()} / ${progressTotal.toLocaleString()} evidence rows prepared locally · no model requests yet`:s.status==='idle'&&!$('recheckConsent').checked?'Check the consent box, then press Recheck saved hits. No images have been sent.':`${done.toLocaleString()} / ${total.toLocaleString()} images · checkpointed locally`;$('recheckSpend').textContent=`$${Number(s.spend||0).toFixed(4)} · ${Number(s.requests||0).toLocaleString()} requests`;
  $('recheckStatus').className='live-label '+(s.status==='error'?'error':busy?'running':'');$('recheckStatus').innerHTML=`<i></i> ${String(s.status||'ready').replaceAll('_',' ').toUpperCase()}`;$('recheckNavStatus').textContent=busy?'RUNNING':s.status==='complete'?'DONE':s.errors?'CHECK':'READY';
  $('startRecheck').textContent=done||s.errors?'▶ Resume / retry remaining':'▶ Recheck saved hits';$('startRecheck').disabled=busy;$('startRecheck').title=busy?'A saved-hit recheck is already active.':'Click to check the required workspace, connection, models, and consent.';$('pauseRecheck').disabled=!pausable;$('openRecheckReport').disabled=!s.reportAvailable;$('clearRecheck').disabled=busy||!((recheckResultDocument?.results||[]).length||done||s.errors||s.reportAvailable);
  document.querySelector('.recheck-consent').classList.toggle('needs-consent',!busy&&total>0&&!$('recheckConsent').checked);
  if(s.last){const ids=(s.last.video_ids||[]).join(', '),cues=[s.last.primary,s.last.secondary].filter(Boolean).join(' + ');$('recheckLatest').textContent=`Image ${s.last.index} · ${ids} · ${String(s.last.final||'').replaceAll('_',' ')}${cues?' · '+cues:''}`;}
  controls();
}

async function refreshRecheck(){try{renderRecheck(await api.call('hit-recheck-info'));applyRecheckResultCounts(await api.call('hit-recheck-results'));}catch(error){toast(error.message);}}
function refreshRecheckModels(){$('recheckPrimary').textContent=$('primaryModel').selectedOptions[0]?.textContent||'Choose a model on Visual review';renderRecheck();}
window.renderRecheck=renderRecheck;window.refreshRecheckModels=refreshRecheckModels;
$('troubleshootNav').onclick=()=>{showView('troubleshoot');refreshRecheck();};
$('recheckConsent').onchange=()=>renderRecheck();
$('startRecheck').onclick=act(async()=>{
  const total=Number(recheckState.uniqueImages||0),primary=$('primaryModel').selectedOptions[0]?.textContent||$('primaryModel').value;
  if(!project){toast('Choose or reopen a Footage Workspace before rechecking saved hits.',true);return;}
  if(!connected){toast('Connect OpenRouter in Connection & settings before rechecking saved hits.',true);return;}
  if(!total){toast('There are no saved evidence images to recheck.',true);return;}
  if(!$('primaryModel').value){toast('Choose a review model on Visual review first.',true);return;}
  if(!$('recheckConsent').checked){document.querySelector('.recheck-consent').classList.add('needs-consent');$('recheckConsent').focus();toast('Check the consent box to approve sending the displayed evidence images through OpenRouter.',true);return;}
  if(!confirm(`Send ${total} distinct saved evidence images through OpenRouter?\n\nReviewer: ${primary}\n\nTitles, URLs, previous claims, and human labels stay local. The original verdict ledger will not be changed.`))return;
  renderRecheck({status:'starting',message:'Checking model availability before any image is sent…'});
  try{renderRecheck(await api.call('start-hit-recheck',{primary:$('primaryModel').value,budget:Number($('recheckBudget').value),workers:Number($('recheckWorkers').value),consent:true}));}
  catch(error){await refreshRecheck();throw error;}
});
$('pauseRecheck').onclick=act(async()=>renderRecheck(await api.call('pause-hit-recheck')));
$('clearRecheck').onclick=act(async()=>{
  if(!confirm('Clear all saved troubleshooting scores and checkpoints?\n\nThe original videos, evidence cards, match verdicts, and human feedback will remain. The evidence can then be scored again from the beginning.'))return;
  const state=await api.call('clear-hit-recheck');recheckResultDocument={results:[]};recheckResultIndex=0;currentRecheckResult=null;
  if($('recheckDialog').open)$('recheckDialog').close();renderRecheck(state);applyRecheckResultCounts(recheckResultDocument);toast('Troubleshooting scores cleared. You can score the saved evidence again.');
});
$('openRecheckReport').onclick=act(()=>api.call('open-hit-recheck-report'));
api.onHitRecheck(renderRecheck);
$('primaryModel').addEventListener('change',refreshRecheckModels);

const recheckOutcome={
  confirmed_hit:{label:'Confirmed again',className:'confirmed',description:'The selected reviewer identified a qualifying visual cue.'},
  rejected_by_primary:{label:'Reviewer said no',className:'rejected',description:'The selected reviewer did not find a definite qualifying visual cue.'},
  rejected_unconfirmed:{label:'Legacy disagreement',className:'rejected',description:'This result came from an older two-reviewer audit.'},
  error:{label:'Error',className:'error',description:'This image was not classified and remains eligible for retry.'}
};
let recheckResultDocument={results:[]},recheckResultFilter='confirmed_hit',recheckResultIndex=0,recheckResultToken=0,currentRecheckResult=null;
const recheckReviewZoom=attachZoom({scroll:$('recheckImageScroll'),image:$('recheckImage'),stage:$('recheckImageStage'),zoomedClass:'zoomed',level:$('recheckZoomLevel'),zoomIn:$('recheckZoomIn'),zoomOut:$('recheckZoomOut'),zoomFit:$('recheckZoomFit'),dialog:$('recheckDialog'),draggable:true});
const filteredRecheckResults=()=>recheckResultDocument.results.filter(item=>item.final===recheckResultFilter).sort((a,b)=>a.index-b.index);
function applyRecheckResultCounts(document){recheckResultDocument=document||{results:[]};const count=final=>recheckResultDocument.results.filter(value=>value.final===final).length;$('recheckConfirmed').textContent=count('confirmed_hit').toLocaleString();$('recheckPrimaryNo').textContent=count('rejected_by_primary').toLocaleString();$('recheckErrors').textContent=count('error').toLocaleString();$('clearRecheck').disabled=!!window.recheckBusy||recheckResultDocument.results.length===0;}
function recheckResultText(result,role){
  if(!result)return null;const node=el('div','model-evidence');
  node.append(el('strong','',`${role} · ${result.model||'model'} · ${String(result.decision||'').toUpperCase()}${result.cue&&result.cue!=='none'?' · '+prettyCue(result.cue):''}`),el('p','',result.evidence||'No evidence explanation was saved.'),el('p','',result.location?`Location: ${result.location}${Number.isFinite(result.confidence)?` · confidence ${Math.round(result.confidence*100)}%`:''}`:''));return node;
}
function renderRecheckResultText(item,index,total){
  currentRecheckResult=item;const meta=recheckOutcome[item.final]||{label:item.final||'Result',className:'',description:''},occurrences=item.occurrences||[],ids=occurrences.map(value=>value.video_id);
  $('recheckDialogEyebrow').textContent=`SAVED-HIT AUDIT · ${meta.label.toUpperCase()}`;$('recheckDialogTitle').textContent=`Image ${item.index}`;$('recheckResultPosition').textContent=`${index+1} of ${total}`;$('recheckResultVideos').textContent=ids.join(', ')||'No associated video ID';
  $('recheckResultBadge').className=`pill ${meta.className}`;$('recheckResultBadge').textContent=meta.label.toUpperCase();
  const cue=item.primary?.cue&&item.primary.cue!=='none'?prettyCue(item.primary.cue):item.secondary?.cue&&item.secondary.cue!=='none'?prettyCue(item.secondary.cue):'No newly confirmed visual cue';
  $('recheckResultCue').textContent=cue;$('recheckResultSummary').textContent=item.error?.message||meta.description;
  const modelNodes=[recheckResultText(item.primary,'Primary'),recheckResultText(item.secondary,'Independent verification')].filter(Boolean);if(item.error){const error=el('div','model-evidence');error.append(el('strong','','Request error'),el('p','',item.error.message||'Unknown error'),el('p','',[item.error.provider,item.error.status&&`HTTP ${item.error.status}`,item.error.code].filter(Boolean).join(' · ')));modelNodes.push(error);}$('recheckResultModels').replaceChildren(...modelNodes);
  $('recheckResultOccurrences').replaceChildren(...occurrences.map(value=>{const node=el('div','recheck-occurrence'),old=value.old_primary;node.append(el('strong','',`${value.video_id}${value.title?' · '+value.title:''}`),el('span','',`${value.copied_from?'Copied from '+value.copied_from+' · ':''}${value.human_status&&value.human_status!=='unlabeled'?'Human label: '+value.human_status:'No human label'}`));if(old)node.append(el('p','',`Old claim · ${prettyCue(old.cue)}: ${old.evidence||''}`));return node;}));
  const rows=[['Image',item.index],['Dimensions',`${item.width||'—'} × ${item.height||'—'}`],['Videos',occurrences.length],['Checked',item.checked_at?new Date(item.checked_at).toLocaleString():'Not completed'],['Pixel hash',String(item.image_sha256||'').slice(0,16)+'…']];$('recheckResultMetadata').replaceChildren(...rows.flatMap(([name,value])=>[el('dt','',name),el('dd','',String(value))]));
  const firstSource=occurrences.find(value=>/^https?:\/\//i.test(value.url||''));$('recheckResultSource').hidden=!firstSource;$('recheckResultSource').dataset.url=firstSource?.url||'';$('previousRecheckResult').disabled=total<2;$('nextRecheckResult').disabled=total<2;
}
function displayRecheckResultImage(image,item){
  if(item!==currentRecheckResult)return;$('recheckImage').src=image.data;$('recheckImageStage').hidden=false;$('recheckImageError').hidden=true;$('recheckFullImage').hidden=image.full;$('recheckImageLabel').textContent=`Image ${item.index} · ${image.full?'full resolution':'fast preview'} · click / Ctrl+wheel to zoom · drag when zoomed`;Promise.resolve($('recheckImage').decode?.()).catch(()=>{}).finally(()=>recheckReviewZoom.reset());
}
async function showRecheckResult(){
  const list=filteredRecheckResults();if(!list.length){currentRecheckResult=null;$('recheckResultPosition').textContent='0 of 0';$('recheckResultVideos').textContent='No saved results in this category yet';$('recheckDialogTitle').textContent=recheckOutcome[recheckResultFilter]?.label||'Audit results';$('recheckResultSummary').textContent='Refresh while the audit is running to load newly completed images.';$('recheckResultModels').replaceChildren();$('recheckResultOccurrences').replaceChildren();$('recheckResultMetadata').replaceChildren();$('recheckImageStage').hidden=true;$('recheckImageError').hidden=false;$('recheckImageError').textContent='No images are currently available in this result category.';$('recheckFullImage').hidden=true;return;}
  recheckResultIndex=Math.max(0,Math.min(recheckResultIndex,list.length-1));const item=list[recheckResultIndex],token=++recheckResultToken;renderRecheckResultText(item,recheckResultIndex,list.length);$('recheckImage').removeAttribute('src');$('recheckImageStage').hidden=true;$('recheckImageError').hidden=false;$('recheckImageError').textContent='Loading this saved evidence image…';$('recheckFullImage').hidden=true;recheckReviewZoom.reset();
  if(!item.image_path){$('recheckImageError').textContent='The checkpoint does not contain a safe saved-image path.';return;}try{const image=await getMatchImage(item.image_path,false);if(token===recheckResultToken)displayRecheckResultImage(image,item);}catch(error){if(token===recheckResultToken)$('recheckImageError').textContent=error.message;}
}
async function refreshRecheckResultDocument(keepCurrent=true){
  const hash=keepCurrent?currentRecheckResult?.image_sha256:null;applyRecheckResultCounts(await api.call('hit-recheck-results'));const list=filteredRecheckResults(),same=hash?list.findIndex(value=>value.image_sha256===hash):-1;recheckResultIndex=same>=0?same:Math.min(recheckResultIndex,Math.max(0,list.length-1));await showRecheckResult();
}
async function openRecheckResults(filter){
  recheckResultFilter=filter;recheckResultIndex=0;currentRecheckResult=null;if(!$('recheckDialog').open)$('recheckDialog').showModal();$('recheckImageStage').hidden=true;$('recheckImageError').hidden=false;$('recheckImageError').textContent='Loading the latest audit checkpoint…';await refreshRecheckResultDocument(false);
}
function moveRecheckResult(delta){const list=filteredRecheckResults();if(!list.length)return;recheckResultIndex=(recheckResultIndex+delta+list.length)%list.length;showRecheckResult();}
document.querySelectorAll('[data-recheck-filter]').forEach(button=>button.onclick=act(()=>openRecheckResults(button.dataset.recheckFilter)));
$('previousRecheckResult').onclick=()=>moveRecheckResult(-1);$('nextRecheckResult').onclick=()=>moveRecheckResult(1);$('refreshRecheckResults').onclick=act(()=>refreshRecheckResultDocument(true));
$('recheckResultSource').onclick=act(()=>api.call('open-url',$('recheckResultSource').dataset.url));
$('recheckFullImage').onclick=act(async()=>{const item=currentRecheckResult;if(!item?.image_path)return;$('recheckFullImage').disabled=true;try{displayRecheckResultImage(await getMatchImage(item.image_path,true),item);}finally{$('recheckFullImage').disabled=false;}});
document.addEventListener('keydown',event=>{if(!$('recheckDialog').open||event.target.closest('input,textarea,select'))return;if(event.key==='ArrowLeft'){event.preventDefault();moveRecheckResult(-1);}else if(event.key==='ArrowRight'){event.preventDefault();moveRecheckResult(1);}});
