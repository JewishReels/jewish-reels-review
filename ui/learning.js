const learningButton=el('button','button subtle','Retrain from feedback');learningButton.id='learningButton';document.querySelector('#reviewView .header-actions').insertBefore(learningButton,$('exportBtn'));
const learningDialog=el('dialog','modal learning-modal');learningDialog.id='learningDialog';
learningDialog.innerHTML='<form method="dialog" class="modal-top"><div><div class="eyebrow">LEARN FROM ALL FEEDBACK</div><h2>Rebuild classification rules from your labels</h2></div><button class="icon-button" aria-label="Close learning">×</button></form><p class="learning-intro">Analyze every current confirmed and false label, merge similar supported lessons into shared rules, then automatically replace the learned entries in Classification rules. Your manual rules remain unchanged. This improves the review instructions; it does not retrain model weights or change saved verdicts.</p><div class="learning-controls"><label>Learning model<select id="learningModel"><option value="">Choose a vision model…</option></select></label><label>Pass budget $<input id="learningBudget" type="number" min="0.01" max="100" step="0.25" value="1"></label><button class="button primary" id="startLearning">Retrain from all feedback</button><button class="button" id="stopLearning" disabled>Stop</button></div><p id="learningPrice" class="learning-note"></p><div class="learning-options"><label><input type="checkbox" id="learningIncludeNotes"> Include my feedback notes</label></div><p class="learning-note">Sends each saved evidence region, sheet context, previous visual claim and its confirmed/false label to the selected model through OpenRouter. Titles and URLs are excluded; notes are sent only if selected. Classification pauses first; preparation continues.</p><p class="learning-note">There is no example limit and no classification-rule count limit. Every retrain starts with the complete current feedback set. Similar rules merge only when their label direction, cue, and observable visual check agree; distinct lookalikes remain separate. The budget may stop new requests after reported spend reaches it; raise it and retrain again to finish the full set. Unknown charges stop the pass.</p><div class="learning-progress" role="status"><strong id="learningStatus">Ready</strong><span id="learningCounts"></span><p id="learningMessage"></p></div><div id="learningLessons" class="learning-lessons"></div>';
document.body.append(learningDialog);
let learningData={state:{status:'idle'},cases:[],lessons:[]},learningStarting=false;
const learningRunning=s=>!!s?.busy||['waiting','running','pausing'].includes(s?.status);
function learningControls(){
 const busy=learningStarting||learningRunning(learningData.state);window.learningBusy=busy;
 for(const id of ['learningModel','learningBudget','learningIncludeNotes'])$(id).disabled=busy;
 const examples=learningData.cases.length;
 $('startLearning').disabled=busy||!examples||!$('learningModel').value||!connected;
 $('stopLearning').disabled=!learningRunning(learningData.state)||learningData.state.status==='pausing';
 learningButton.textContent=busy?'Retraining…':'Retrain from feedback';learningButton.disabled=!project;
 const m=models.find(m=>m.id===$('learningModel').value),positive=learningData.cases.filter(c=>c.label==='confirmed_hit').length,negative=examples-positive;
 $('learningPrice').textContent=m?`${m.name} · $${(Number(m.pricing.prompt||0)*1e6).toLocaleString()} input / $${(Number(m.pricing.completion||0)*1e6).toLocaleString()} output per million tokens. ${examples} label(s): ${positive} confirmed, ${negative} false.`:`Choose the vision model for rule generation. ${examples} label(s): ${positive} confirmed, ${negative} false.`;
 controls();
}
function renderLearningState(s){learningData.state=s;const busy=learningRunning(s);$('learningStatus').textContent=String(s.status||'idle').toUpperCase();$('learningCounts').textContent=`${s.done||0}/${s.total||0} examined · ${s.attempts||0} requests · ${s.ruleCount||0} rules · ${s.estimated?'~':''}$${Number(s.spend||0).toFixed(4)} this pass`; $('learningMessage').textContent=s.message||'Confirm or reject hits to create labeled examples.';learningControls();if(!busy&&learningDialog.open)refreshLessons().catch(e=>toast(e.message,true));}
function renderLessons(){
 const list=$('learningLessons');list.replaceChildren();
 if(!learningData.lessons.length){list.append(el('p','learning-empty',learningData.cases.length?'Your positive and negative labels are ready. Choose a learning model and retrain.':'No feedback has been saved. Open a hit and mark it Confirmed or False first.'));return;}
 for(const lesson of learningData.lessons){
  const card=el('article','learning-lesson'),heading=el('div','lesson-heading'),supported=lesson.analysis&&['false_positive','confirmed_hit'].includes(lesson.analysis.assessment);
  const badge=lesson.stale?'LABEL UNDONE / REPLACED':lesson.active?lesson.merged_count>1?`MERGED · ${lesson.merged_count} EXAMPLES`:'RULE SAVED':lesson.status==='ready'?lesson.analysis.assessment==='unclear'?'UNCLEAR EVIDENCE':lesson.analysis.assessment==='label_disputed'||lesson.analysis.assessment==='original_hit_supported'?'MODEL DISAGREES':supported?'RULE NOT CURRENT':'NO RULE':lesson.status.toUpperCase();
  heading.append(el('strong','',lesson.video_id),el('span',`pill ${lesson.active?'hit':''}`,badge));card.append(heading,el('p','learning-note',`${lesson.feedback_action==='confirmed_hit'?'Confirmed':'False'} · ${lesson.model} · ${new Date(lesson.created_at).toLocaleString()}`));
  if(lesson.analysis){const a=lesson.analysis;for(const [label,text]of [['Visible evidence',a.visible_evidence],['Analysis',a.mistake],['Classification rule',a.check],['Visual boundary',a.preserve_true_hits]])if(text)card.append(el('h3','',label),el('p','',text));}
  else card.append(el('p','',lesson.error||'No usable explanation was saved.'));
  const actions=el('div','lesson-actions'),entry=entries.find(e=>e.feedback_target===lesson.target_key);
  if(entry){const inspect=el('button','button subtle','View labeled evidence');inspect.onclick=act(async()=>{learningDialog.close();await openEvidence(entry);});actions.append(inspect);}
  card.append(actions);list.append(card);
 }
}
async function refreshLessons(){if(!project)return;const data=await api.call('get-learning');learningData=data;renderLessons();learningControls();}
learningButton.onclick=act(async()=>{
 const data=await api.call('get-learning');learningData=data;
 const placeholder=el('option','','Choose a vision model…');placeholder.value='';
 $('learningModel').replaceChildren(placeholder,...models.map(m=>{const o=el('option','',m.name);o.value=m.id;return o;}));
 $('learningModel').value=models.some(m=>m.id===data.model)?data.model:'';$('learningBudget').value=data.budget;
 renderLessons();renderLearningState(data.state);learningDialog.showModal();
});
$('learningModel').onchange=learningControls;
$('startLearning').onclick=act(async()=>{learningStarting=true;learningControls();try{await api.call('start-learning',{model:$('learningModel').value,budget:Number($('learningBudget').value),includeNotes:$('learningIncludeNotes').checked});await refreshLessons();}finally{learningStarting=false;learningControls();}});
$('stopLearning').onclick=act(()=>api.call('stop-learning'));
api.onLearning(renderLearningState);api.onLearningUpdated(()=>{if(project)refreshLessons().catch(e=>toast(e.message,true));});
