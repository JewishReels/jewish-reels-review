const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {providerError}=require('../lib/diagnostics.cjs'),{reviewImage}=require('../lib/openrouter.cjs'),{ReviewEngine}=require('../lib/engine.cjs'),S=require('../lib/storage.cjs');
const model={id:'test/vision',name:'Local provider test',architecture:{input_modalities:['image','text'],output_modalities:['text']},pricing:{},supported:['response_format']};
const no={decision:'no',cue:'none',evidence:'No strict visible cue in these synthetic test pixels.',location:'',confidence:.8,box:null};
const refusal={code:400,message:'Provider returned error',metadata:{provider_name:'Alibaba',raw:'data: {"error":{"code":"data_inspection_failed","param":null,"message":"Input image data may contain inappropriate content.","type":"data_inspection_failed"},"id":"test-refusal"}\n\n'}};
const image={data:'UElYRUxT',mime:'image/png'};
async function fixture(t,cards={'1':['a','b'],'2':['c']}){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-provider-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const[id,values]of Object.entries(cards)){const dir=path.join(root,'frames',id,'cards');await fs.mkdir(dir,{recursive:true});for(let i=0;i<values.length;i++)await fs.writeFile(path.join(dir,`card_${i+1}.jpg`),values[i]);}return root;
}
const prepareCard=async p=>[{data:(await fs.readFile(p)).toString('base64'),mime:'image/png',bounds:{x:0,y:0,width:100,height:100}}];
const options=root=>({root,key:'LOCAL_SIMULATION_ONLY',primary:model,budget:10});
function transport(t,handler){t.mock.method(global,'fetch',async(url,opts)=>{const payload=JSON.parse(opts.body);assert.ok(payload.messages[1].content[1].image_url.url.startsWith('data:image/png;base64,'));return handler(payload);});}
const denied=()=>new Response(JSON.stringify({error:refusal}),{status:400});
const accepted=()=>new Response(JSON.stringify({id:Math.random().toString(),usage:{cost:.001},choices:[{finish_reason:'stop',message:{content:JSON.stringify(no)}}]}),{status:200});
test('nested SSE refusal exposes provider code and human-readable reason',()=>{
 const result=providerError(refusal);assert.equal(result.provider_code,'data_inspection_failed');assert.equal(result.provider_message,'Input image data may contain inappropriate content.');assert.equal(result.provider,'Alibaba');
 assert.equal(providerError({...refusal,metadata:{...refusal.metadata,raw:JSON.stringify({error:{code:'invalid_image',message:'Could not decode image'}})}}).provider_code,'invalid_image');
});
test('HTTP 400 content rejection is held for manual review, with no format fallback or retry flag',async t=>{
 let calls=0;transport(t,()=>{calls++;return denied();});
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.code==='PROVIDER_CONTENT_REJECTED'&&e.videoBlocked&&e.status===400&&!e.transient&&!e.fallbackMode&&/Alibaba.*data_inspection_failed/.test(e.message));assert.equal(calls,1);
});
test('Alibaba inappropriate-content 502 is a manual hold rather than a transient retry',async t=>{
 let calls=0;transport(t,()=>{calls++;return new Response(JSON.stringify({error:{code:502,message:'Upstream error from Alibaba: Output data may contain inappropriate content.',metadata:{provider_name:'Alibaba'}}}),{status:502});});
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.code==='PROVIDER_CONTENT_REJECTED'&&e.videoBlocked&&e.status===502&&!e.transient);assert.equal(calls,1);
});
test('saved Alibaba 502 and changed-source retries migrate to durable manual holds',async t=>{
 const root=await fixture(t,{'1':['blocked'],'2':['changed']});await fs.mkdir(path.join(root,'logs'),{recursive:true});
 await S.atomicJson(path.join(root,'logs/reelsight_deferred.json'),{version:1,videos:[
  {id:'1',code:'TRANSIENT_PROVIDER',message:'Alibaba did not complete this image response: Alibaba (HTTP 502): Upstream error from Alibaba: Output data may contain inappropriate content.',provider_message:'Upstream error from Alibaba: Output data may contain inappropriate content.',recovery_kind:'provider',attempts:3,next_retry_at:Date.now()+120000},
  {id:'2',code:'INPUT_UNAVAILABLE',message:'Source video differs from its prepared receipt. Keeping this video pending.',attempts:8,next_retry_at:Date.now()+120000}
 ]});
 let calls=0;transport(t,()=>{calls++;return accepted();});const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run(options(root));
 assert.equal(calls,0);assert.equal(e.state.status,'attention');assert.deepEqual(e.state.deferred.map(v=>[v.id,v.manual,v.next_retry_at,v.recovery_kind]),[['1',true,null,'provider_content'],['2',true,null,'source_changed']]);
});
test('a refusal preserves partial coverage, finishes the next video and never saves no for the held ID',async t=>{
 const root=await fixture(t);let calls=0;transport(t,()=>++calls===2?denied():accepted());
 const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run(options(root));
 assert.equal(e.state.status,'attention');assert.equal(calls,3);assert.equal(e.state.done,1);assert.equal(e.state.total,2);assert.equal(e.state.formatRetries,0);assert.equal(e.state.retries,0);
 assert.deepEqual((await S.loadLedger(root)).entries.map(v=>v.id),['2']);
 const pending=(await S.readJson(path.join(root,'logs/reelsight_deferred.json'))).videos[0];assert.equal(pending.id,'1');assert.equal(pending.manual,true);assert.equal(pending.next_retry_at,null);assert.equal(pending.card,'card_2.jpg');assert.equal(pending.provider,'Alibaba');
 const cp=(await S.readJson(path.join(root,'logs/reelsight_checkpoint.json'))).videos['1'];assert.deepEqual(cp.completedCards,['card_1.jpg']);assert.equal(Object.keys(cp.regions).length,1);
 assert.equal(await S.exists(path.join(root,'frames/1/cards/card_2.jpg')),true);
 // Restart with another selected model still does not automatically resend a refusal.
 const resumed=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await resumed.run({...options(root),primary:{...model,id:'test/other'}});assert.equal(calls,3);assert.equal(resumed.state.status,'attention');
});
test('same source pixels under another ID inherit the manual hold without an image request',async t=>{
 const root=await fixture(t,{'1':['same'],'2':['same'],'3':['different']});let calls=0;transport(t,()=>++calls===1?denied():accepted());
 const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run(options(root));
 assert.equal(calls,2);assert.equal(e.state.deferred.length,2);assert.equal(e.state.deferred.find(v=>v.id==='2').copied_from,'1');assert.deepEqual((await S.loadLedger(root)).entries.map(v=>v.id),['3']);
});
test('held video does not keep a drained producer queue spinning or become complete',async t=>{
 const root=await fixture(t,{'1':['blocked']});let calls=0;transport(t,()=>{calls++;return denied();});
 const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run({...options(root),followPreparation:()=>({running:false,status:'complete'})});
 assert.equal(e.state.status,'attention');assert.equal(calls,1);assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('HTTP 200 refusal still accounts its reported cost and receives a manual hold',async t=>{
 const root=await fixture(t,{'1':['blocked']});transport(t,()=>new Response(JSON.stringify({usage:{cost:.03},provider:'Test provider',choices:[{finish_reason:'content_filter',message:{content:JSON.stringify(no)}}]}),{status:200}));
 const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run(options(root));
 assert.equal(e.state.status,'attention');assert.equal(e.state.spend,.03);assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('a sibling checkpoint failure takes precedence over a content refusal',async t=>{
 const root=await fixture(t,{'1':['blocked','valid'],'2':['next']});let calls=0,started;const both=new Promise(r=>{started=r;});transport(t,async()=>{if(++calls===1){await both;return denied();}started();await new Promise(r=>setTimeout(r,30));return accepted();});
 const atomic=S.atomicJson;t.mock.method(S,'atomicJson',(p,...args)=>p.endsWith('reelsight_checkpoint.json')?Promise.reject(Object.assign(new Error('Checkpoint unavailable'),{code:'EPERM'})):atomic(p,...args));
 const e=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{spacingMs:0}});await e.run({...options(root),workers:2,dispatchMode:'concurrent'});
 assert.equal(e.state.status,'error');assert.match(e.state.message,/Checkpoint unavailable/);assert.equal(e.state.deferred.length,0);assert.equal((await S.loadLedger(root)).entries.length,0);
});
