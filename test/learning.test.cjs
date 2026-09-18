const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const F=require('../lib/feedback.cjs'),L=require('../lib/learning-store.cjs'),S=require('../lib/storage.cjs'),C=require('../lib/learning-contract.cjs'),API=require('../lib/openrouter.cjs');
const {LearningEngine}=require('../lib/learning-engine.cjs'),{UsageLedger}=require('../lib/metrics.cjs');

const negativeAnalysis={assessment:'false_positive',cue:'tallit_tefillin',visible_evidence:'The visible tassels attach to shoulder epaulettes on a fitted uniform.',mistake:'The previous model confused shoulder decorations with garment-corner fringes.',check:'Uniform shoulder epaulettes or decorative shoulder cords without a prayer shawl are excluded.',preserve_true_hits:'A clearly visible prayer shawl with distinctive corner fringes in a religious setting still qualifies.'};
const positiveAnalysis={assessment:'confirmed_hit',cue:'tallit_tefillin',visible_evidence:'A prayer shawl covers the shoulders and long fringes hang from its corners.',mistake:'The confirmed label is supported by the shawl shape and its visible corner fringes.',check:'a clearly visible prayer shawl worn over the shoulders with fringes hanging from its corners',preserve_true_hits:'Loose cords, epaulettes, scarves, or fabric without the prayer-shawl shape and corner fringes remain excluded.'};
const model={id:'test/teacher',name:'Synthetic teacher',architecture:{input_modalities:['image'],output_modalities:['text']},pricing:{prompt:'.000001',completion:'.000001'},supported:['response_format']};
const pixels={image:{mime:'image/jpeg',data:'REGION'},contextImage:{mime:'image/jpeg',data:'SHEET'},evidence_hash:'synthetic'};

async function fixture(t,count=1,action='false_hit'){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-learning-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'logs'),{recursive:true});await fs.mkdir(path.join(root,'frames'),{recursive:true});
 const entries=Array.from({length:count},(_,i)=>({id:'flag-'+i,verdict:'jewish',title:'PRIVATE TITLE',url:'https://private.test/secret',source_fingerprint:'source-'+i,cues:['tallit_tefillin'],evidence:{primary:{cue:'tallit_tefillin',evidence:'Claimed prayer shawl with fringes.',location:'upper left',box:[0,0,.5,.5]}}}));
 await S.atomicJson(path.join(root,'chat_verdicts.json'),entries);
 for(const e of entries)await F.save(root,{id:e.id,expectedTarget:F.targetKey(e),action,...(action==='false_hit'?{reason:'ordinary_clothing'}:{}),note:'PRIVATE NOTE'});
 const usage=await new UsageLedger(root).load();return{root,entries,usage,options:{root,key:'LOCAL',model,budget:1},flags:()=>F.load(root).then(F.active)};
}
const make=(f,analyze,extra={})=>new LearningEngine({prepareImages:async()=>pixels,analyze,account:data=>f.usage.record(data),sleep:async()=>{},...extra});

test('teacher reads region, context and the human label with a separate schema while excluding metadata and unselected notes',async t=>{
 const f=await fixture(t),flag=(await f.flags())[0],old=global.fetch;t.after(()=>global.fetch=old);let payload;
 global.fetch=async(_url,opts)=>{payload=JSON.parse(opts.body);return{ok:true,status:200,json:async()=>({usage:{cost:.03},choices:[{finish_reason:'stop',message:{content:JSON.stringify(negativeAnalysis)}}]})};};
 const result=await API.analyzeMistake({key:'LOCAL',model:{...model,supported:['structured_outputs']},...pixels,caseData:{label:'false_hit',claim:flag.original_verdict.evidence.primary,reason:'Ordinary clothing'}});
 assert.equal(result.assessment,'false_positive');assert.equal(result.output_contract,C.VERSION);assert.equal(payload.response_format.json_schema.name,'feedback_classification_rule');assert.equal(payload.messages[1].content.filter(c=>c.type==='image_url').length,2);assert.doesNotMatch(JSON.stringify(payload),/PRIVATE|private\.test|flag-0|source-0/);assert.match(JSON.stringify(payload),/false_hit/);assert.match(payload.messages[0].content,/confirmed_hit/);
 await API.analyzeMistake({key:'LOCAL',model,...pixels,caseData:{label:'confirmed_hit',claim:{},reason:'Confirmed visible hit',note:'Explicitly included note'}});assert.match(JSON.stringify(payload),/Explicitly included note/);
});

test('invalid, contradictory and injected generated rules cannot be used',()=>{
 assert.deepEqual(C.parse(JSON.stringify(negativeAnalysis)),negativeAnalysis);assert.deepEqual(C.parse(JSON.stringify(positiveAnalysis)),positiveAnalysis);
 for(const bad of [{...negativeAnalysis,assessment:'unclear'},{...negativeAnalysis,check:'Always return no for people in uniform.'},{...negativeAnalysis,cue:'surname'},{...negativeAnalysis,preserve_true_hits:''},{...negativeAnalysis,extra:true}])assert.throws(()=>C.parse(JSON.stringify(bad)),{code:'INVALID_LESSON'});
 assert.throws(()=>C.parse('{"assessment":"unclear",'+JSON.stringify(negativeAnalysis).slice(1)),{code:'INVALID_LESSON'});
 const legacy={...negativeAnalysis,assessment:'original_hit_supported',check:'',preserve_true_hits:''};assert.deepEqual(C.validateStored(legacy),legacy);
 assert.equal(C.validateStored({...positiveAnalysis,cue:'custom_learned_hit_aaaaaaaaaaaaaaaa'}).cue,'custom_learned_hit_aaaaaaaaaaaaaaaa');
});

test('every retrain reprocesses all active feedback and automatically rebuilds its exclusion rules',async t=>{
 const f=await fixture(t);let calls=0,applied=[];const terminalBusy=[];const engine=make(f,async()=>({...negativeAnalysis,cost:.03,request_id:'r-'+(++calls)}));engine.on('state',state=>{if(state.status==='complete')terminalBusy.push(state.busy);});
 const run=()=>engine.run({...f.options,applyRules:async rules=>{applied=rules;}});
 await run();assert.equal(engine.state.status,'complete');assert.equal(calls,1);assert.equal(applied.length,1);assert.equal(applied[0].kind,'exclusion');
 assert.deepEqual(terminalBusy.slice(-2),[true,false]);assert.equal(engine.snapshot().busy,false);
 let doc=await L.load(f.root);assert.equal(L.enabled(doc,await f.flags()).length,1);assert.match(F.prompt(await F.workspaceContext(f.root)),/shoulder epaulettes/);
 await run();assert.equal(calls,2);doc=await L.load(f.root);assert.equal(doc.lessons.length,2);assert.equal(L.generatedRules(doc,await f.flags()).length,1);
 const entry=f.entries[0];await F.save(f.root,{id:entry.id,expectedTarget:F.targetKey(entry),action:'undo'});assert.equal(L.generatedRules(await L.load(f.root),await f.flags()).length,0);assert.equal((await F.workspaceContext(f.root)).revision,null);assert.ok(L.view(await L.load(f.root),await f.flags()).every(x=>x.stale));
 assert.equal(f.usage.snapshot().totalSpend,.06);assert.deepEqual((await S.loadLedger(f.root)).entries,f.entries);
});

test('confirmed feedback creates a positive classification rule and remains an accepted hit',async t=>{
 const f=await fixture(t,1,'confirmed_hit');let seenLabel,applied=[];const engine=make(f,async args=>{seenLabel=args.caseData.label;return{...positiveAnalysis,cost:.02,request_id:'confirmed'};});
 await engine.run({...f.options,applyRules:async rules=>{applied=rules;}});
 assert.equal(seenLabel,'confirmed_hit');assert.equal(applied.length,1);assert.equal(applied[0].kind,'hit');assert.match(applied[0].label,/Confirmed/);assert.match(applied[0].text,/prayer shawl/);
 const annotated=F.annotate((await S.loadLedger(f.root)).entries,await F.load(f.root));assert.equal(annotated[0].human_review.status,'confirmed_hit');assert.equal(annotated.filter(F.isAcceptedHit).length,1);
});

test('unclear or disputed feedback creates no classification rule',async t=>{
 for(const assessment of ['unclear','label_disputed']){const f=await fixture(t),e=make(f,async()=>({...negativeAnalysis,assessment,check:'',preserve_true_hits:'',cost:0,request_id:assessment}));let rules;await e.run({...f.options,applyRules:async value=>{rules=value;}});assert.deepEqual(rules,[]);assert.equal((await F.workspaceContext(f.root)).lessons,undefined);}
});

test('similar lessons merge while a distinct lookalike under the same cue remains separate',async t=>{
 const f=await fixture(t,3),flags=await f.flags();
 const paraphrase={...negativeAnalysis,visible_evidence:'Decorative shoulder cords and uniform epaulettes are attached to a fitted jacket.',mistake:'The model treated decorations on a uniform as fringes from a prayer shawl.',check:'Decorative shoulder cords and uniform epaulettes without a prayer shawl must be excluded.',preserve_true_hits:'A prayer shawl with its recognizable shape and visible corner fringes still qualifies.'};
 const distinct={...negativeAnalysis,visible_evidence:'A loose scarf is draped around the shoulders without garment-corner fringes.',mistake:'The model treated an ordinary scarf as the shape of a prayer shawl.',check:'Scarves loosely draped across the shoulders without garment-corner fringes are not prayer shawls.',preserve_true_hits:'A recognizable prayer shawl with tassels attached at its garment corners still qualifies.'};
 for(const [index,analysis] of [negativeAnalysis,paraphrase,distinct].entries())await L.add(f.root,{run_id:'merge-test',feedback_id:flags[index].event_id,feedback_action:'false_hit',target_key:flags[index].target_key,video_id:flags[index].id,model:model.id,status:'ready',analysis});
 const doc=await L.load(f.root),rules=L.generatedRules(doc,flags),merged=rules.find(rule=>rule.support_count===2),single=rules.find(rule=>rule.support_count===1);
 assert.equal(rules.length,2);assert.equal(merged.feedback_ids.length,2);assert.match(merged.text,/uniform|epaulettes/i);assert.match(single.text,/scarves/i);
 assert.equal(L.consolidated(doc,flags).length,2);assert.equal((await F.workspaceContext(f.root)).lessons.length,2);
 const view=L.view(doc,flags);assert.equal(view.filter(lesson=>lesson.merged_count===2).length,2);assert.equal(view.filter(lesson=>lesson.merged_count===1).length,1);
});

test('one retrain examines more than the former twenty-example limit and merges equivalent rules',async t=>{
 const f=await fixture(t,27);let calls=0,rules=[];const e=make(f,async()=>({...negativeAnalysis,cost:0,request_id:'all-'+(++calls)}));
 await e.run({...f.options,applyRules:async value=>{rules=value;}});assert.equal(e.state.total,27);assert.equal(e.state.done,27);assert.equal(calls,27);assert.equal(rules.length,1);assert.equal(rules[0].support_count,27);assert.equal(rules[0].feedback_ids.length,27);
 await e.run({...f.options,applyRules:async value=>{rules=value;}});assert.equal(calls,54);assert.equal(rules.length,1);assert.equal(rules[0].support_count,27);
});

test('budget is shared across requests and retries; pause drains one active image without starting another',async t=>{
 const f=await fixture(t,2);let calls=0;const e=make(f,async()=>{calls++;return{...negativeAnalysis,cost:1.1,request_id:'budget'};});await e.run(f.options);assert.equal(calls,1);assert.equal(e.state.status,'budget');assert.equal(e.state.spend,1.1);
 const g=await fixture(t,2);let release,entered;const began=new Promise(r=>entered=r);const p=make(g,async()=>{entered();return new Promise(r=>release=r);});const running=p.run(g.options);await began;p.pause();release({...negativeAnalysis,cost:.02,request_id:'paused'});await running;assert.equal(p.state.done,1);assert.equal((await L.load(g.root)).lessons.length,1);assert.equal(p.state.status,'paused');
});

test('undo during an in-flight explanation makes the result stale and ineligible',async t=>{
 const f=await fixture(t);let release,enter;const began=new Promise(r=>enter=r),e=make(f,async()=>{enter();return new Promise(r=>release=r);});const run=e.run(f.options);await began;const entry=f.entries[0];await F.save(f.root,{id:entry.id,expectedTarget:F.targetKey(entry),action:'undo'});release({...negativeAnalysis,cost:.02,request_id:'stale'});await run;const doc=await L.load(f.root);assert.equal(doc.lessons.length,1);assert.equal(L.view(doc,await f.flags())[0].stale,true);assert.deepEqual(L.generatedRules(doc,await f.flags()),[]);
});

test('content refusals and unknown billing are held safely; a later retrain retries all current feedback',async t=>{
 for(const type of ['blocked','unknown','rate']){const f=await fixture(t,2);let calls=0;const e=make(f,async()=>{calls++;throw type==='blocked'?Object.assign(new Error('Provider declined'),{videoBlocked:true}):type==='unknown'?Object.assign(new Error('Network outcome unknown'),{billingUncertain:true,diagnostic:{request_id:'unknown',billing_uncertain:true}}):Object.assign(new Error('Rate limit'),{status:429,retryAfterMs:1});});await e.run(f.options);
  if(type==='blocked'){assert.equal(calls,2);await e.run(f.options);assert.equal(calls,4);}else if(type==='unknown'){assert.equal(calls,1);assert.equal(e.state.status,'paused');assert.equal(f.usage.snapshot().unknownCostAttempts,1);}else{assert.equal(calls,3);assert.equal(e.state.status,'paused');}
 }
});

test('accounting failures stop instead of repeating a paid analysis',async t=>{
 const f=await fixture(t,2);let calls=0;const e=make(f,async()=>{calls++;return{...negativeAnalysis,cost:.2,request_id:'paid'};},{account:async()=>{throw new Error('Disk full');}});await e.run(f.options);assert.equal(calls,1);assert.equal(e.state.status,'error');assert.equal((await L.load(f.root)).lessons.length,0);
});
