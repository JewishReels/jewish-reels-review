const fs=require('node:fs/promises'),path=require('node:path'),{EventEmitter}=require('node:events'),{randomUUID}=require('node:crypto');
const F=require('./feedback.cjs'),L=require('./learning-store.cjs'),S=require('./storage.cjs'),C=require('./learning-contract.cjs');

class LearningEngine extends EventEmitter {
 constructor({analyze,prepareImages,account,sleep=ms=>new Promise(r=>setTimeout(r,ms))}){
  super();Object.assign(this,{analyze,prepareImages,account,sleep});this.running=false;
  this.state={status:'idle',total:0,done:0,spend:0,attempts:0,ruleCount:0,message:'Label hits as confirmed or false, then retrain from all feedback.'};
 }
 update(value){Object.assign(this.state,value);this.emit('state',this.snapshot());}
 snapshot(){return JSON.parse(JSON.stringify({...this.state,busy:this.running}));}
 pause(){this.stop=true;this.update({status:'pausing',message:'Stopping after the current response and classification rules are saved…'});}
 async run({root,key,model,budget=1,includeNotes=false,beforeStart=async()=>{},applyRules=async()=>{},policy}){
  if(this.running)throw new Error('A learning pass is already running.');
  if(!key||!model?.id)throw new Error('Choose a learning model and configure OpenRouter.');
  if(!Number.isFinite(budget)||budget<.01||budget>100)throw new Error('Learning budget must be $0.01–$100.');
  this.running=true;this.stop=false;this.stopReason=null;
  const pack=C.forPolicy(policy),runId=randomUUID();
  this.update({status:'waiting',total:0,done:0,spend:0,attempts:0,ruleCount:0,estimated:false,unknownCost:false,current:null,runId,model:model.id,budget,message:'Saving active classification requests before retraining…'});
  const log=record=>fs.appendFile(path.join(root,'logs','reelsight_learning.jsonl'),JSON.stringify({at:new Date().toISOString(),run_id:runId,purpose:'feedback-rule-learning',...record})+'\n');
  const billed=new Set();
  const charge=async(data)=>{const id=data.request_id||data.generation||randomUUID();if(billed.has(id))return;await this.account({...data,request_id:id,purpose:'feedback-rule-learning'});billed.add(id);if(Number.isFinite(data.cost))this.update({spend:this.state.spend+data.cost,estimated:this.state.estimated||!!data.estimated});if(data.billing_uncertain)this.update({unknownCost:true});};
  const persist=()=>S.atomicJson(path.join(root,'feedback','learning_live.json'),this.snapshot());
  try{
   await fs.mkdir(path.join(root,'logs'),{recursive:true});await beforeStart();if(this.stop)return;
   const examples=F.active(await F.load(root));
   this.update({status:'running',total:examples.length,message:examples.length?'Retraining from every current confirmed and false label, then merging similar visual rules…':'No feedback is labeled yet. Confirm or reject saved hits first.'});await persist();
   for(const example of examples){
    if(this.stop||this.state.spend>=budget||this.state.unknownCost)break;
    if(!F.active(await F.load(root)).some(f=>f.event_id===example.event_id)){this.update({done:this.state.done+1});continue;}
    this.update({current:example.id,message:`Examining ${example.id} (${example.action==='confirmed_hit'?'confirmed':'false'}) with ${model.name||model.id}…`});await persist();
    const base={run_id:runId,feedback_id:example.event_id,feedback_action:example.action,target_key:example.target_key,video_id:example.id,model:model.id,include_notes:!!includeNotes};let prepared;
    try{prepared=await this.prepareImages(root,example);}catch(e){await L.add(root,{...base,status:'missing',error:e.message});this.update({done:this.state.done+1});continue;}
    const original=example.original_verdict;
    const reason=example.action==='confirmed_hit'?F.CONFIRMED_REASON.label:F.REASONS.find(r=>r.id===example.reason)?.label;
    const caseData={label:example.action,claim:original?.evidence?.primary||{cue:original?.cues?.[0],evidence:'The detailed original claim is unavailable. Inspect the human-labeled image.'},reason,note:includeNotes?example.note:undefined};
    let attempt=0,formatMode,terminal=false;
    while(!terminal&&!this.stop&&this.state.spend<budget&&!this.state.unknownCost){
     let result;
     try{
      result=await this.analyze({key,model,...prepared,policy,caseData,formatRetry:attempt>0,formatMode,onDiagnostic:async d=>{if(d.event==='request_started')this.update({attempts:this.state.attempts+1});await log({feedback_id:example.event_id,label:example.action,id:example.id,...d});}});
     }catch(e){
      if(e.accounting)await charge({...e.accounting,request_id:e.accounting.request_id||e.diagnostic?.request_id});
      const unknown=!!e.billingUncertain||!!e.diagnostic?.billing_uncertain||!!e.accounting?.billing_uncertain;
      if(unknown)await charge({request_id:e.diagnostic?.request_id,billing_uncertain:true});
      await log({feedback_id:example.event_id,label:example.action,error:e.message,error_code:e.code,status:e.status,billing_uncertain:unknown});
      if(!e.videoBlocked&&!unknown&&attempt<2&&!this.stop&&this.state.spend<budget&&(e.code==='INVALID_LESSON'||e.code==='INVALID_VISUAL_RESULT'||e.code==='OUTPUT_FORMAT_UNSUPPORTED'||e.transient||e.status===429)){
       attempt++;if(e.fallbackMode)formatMode=e.fallbackMode;
       const wait=Math.max(e.retryAfterMs||0,e.status===429?4000:2000)*attempt;
       if(wait<=120000){this.update({retryAt:Date.now()+wait,message:`Learning response unavailable. Same-image retry ${attempt}/2 in ${Math.ceil(wait/1000)}s.`});for(let elapsed=0;elapsed<wait&&!this.stop;elapsed+=250)await this.sleep(Math.min(250,wait-elapsed));this.update({retryAt:null});continue;}
      }
      await L.add(root,{...base,status:e.videoBlocked?'blocked':unknown?'uncertain_cost':'failed',error:e.message,evidence_hash:prepared.evidence_hash});terminal=true;
      if(unknown||[401,402,429].includes(e.status)||e.retryAfterMs>120000){this.stop=true;this.stopReason=unknown?'Stopped: the provider did not confirm the cost of an attempt. Check the saved logs before continuing.':e.message;this.update({message:this.stopReason});}
      continue;
     }
     // Accounting and persistence failures must stop the pass, never resend a paid answer.
     await charge(result);
     const analysis=pack.validate(Object.fromEntries(['assessment','cue','visible_evidence','mistake','check','preserve_true_hits'].map(k=>[k,result[k]])));
     await L.add(root,{...base,status:this.state.unknownCost?'uncertain_cost':'ready',analysis,...(this.state.unknownCost?{error:'Provider usage was unavailable. Analysis saved, but the pass stopped for a cost check.'}:{}),evidence_hash:prepared.evidence_hash,request_id:result.request_id,cost:result.cost,estimated:result.estimated});terminal=true;
    }
    this.update({done:this.state.done+1});await persist();
   }
   const feedback=F.active(await F.load(root)),rules=L.generatedRules(await L.load(root),feedback,policy?.labels||{});
   await applyRules(rules);
   this.update({ruleCount:rules.length,status:this.stop||this.state.unknownCost?'paused':this.state.done<this.state.total?'budget':'complete',current:null,message:this.stopReason||(this.state.unknownCost?'Stopped: provider usage is unknown. Saved analyses and consolidated classification rules are retained for a cost check.':this.stop?`Retraining paused. ${rules.length} consolidated feedback rule(s) are saved in Classification rules.`:this.state.done<this.state.total?`Learning budget reached. ${rules.length} consolidated feedback rule(s) are saved; raise the budget and retrain to process all ${this.state.total} labels.`:`Retraining finished. ${rules.length} consolidated feedback rule(s) were rebuilt in Classification rules.`)});
  }catch(e){this.update({status:'error',message:e.message});}
  finally{if(this.state.status==='waiting'||this.state.status==='pausing')this.update({status:'paused'});this.running=false;await persist().catch(e=>this.update({status:'error',message:`Could not save learning status: ${e.message}`}));this.update({});this.emit('finished',this.snapshot());}
  return this.snapshot();
 }
}
module.exports={LearningEngine};
