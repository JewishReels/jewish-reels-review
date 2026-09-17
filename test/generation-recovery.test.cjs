const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {reviewImage}=require('../lib/openrouter.cjs'),{ReviewEngine}=require('../lib/engine.cjs'),S=require('../lib/storage.cjs'),{VERSION}=require('../lib/policy.cjs');
const model={id:'test/vision',architecture:{input_modalities:['image'],output_modalities:['text']},supported:['response_format'],pricing:{}};
const no={decision:'no',cue:'none',evidence:'No strict visible cue in the synthetic test image.',location:'',confidence:.9,box:null};
const image={data:'UElYRUxT',mime:'image/png'};
const response=(finish='stop',cost=.001,extra={})=>new Response(JSON.stringify({provider:'Test provider',id:`fixture-${Math.random()}`,usage:{cost},choices:[{finish_reason:finish,message:{content:JSON.stringify(no)}}],...extra}),{status:200});
async function fixture(t,ids=['1']){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-generation-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));for(const id of ids){const d=path.join(root,'frames',id,'cards');await fs.mkdir(d,{recursive:true});for(let i=1;i<=6;i++)await fs.writeFile(path.join(d,`card_${i}.jpg`),`${id}:${i}`);}return root;}
const prepareCard=async p=>Array.from({length:4},(_,i)=>({...image,data:Buffer.from(`${p}:${i}`).toString('base64'),bounds:{x:i,y:0,width:20,height:20}}));
const options=root=>({root,key:'LOCAL_ONLY',primary:model,detail:true,budget:10,workers:4,dispatchMode:'concurrent'});
async function seed23(root){const video=(await S.discover(root)).videos[0],cp={configKey:S.sha(JSON.stringify({policy:VERSION,primary:model.id,secondary:null,verificationMode:null,detail:true})),fingerprint:await S.fingerprintVideo(video),cardSignature:await S.fingerprintCards(video),completedCards:['card_1.jpg','card_2.jpg','card_3.jpg','card_4.jpg','card_6.jpg'],regions:{},disagreements:0};for(let c=1;c<=6;c++)for(let r=0;r<4;r++)if(c!==5||r!==0)cp.regions[`card_${c}.jpg:${r}`]={primary:{...no,cost:0,request_id:`saved-${c}-${r}`}};await S.atomicJson(path.join(root,'logs/reelsight_checkpoint.json'),{version:1,videos:{'1':cp}});return cp;}
test('HTTP 200 finish_reason error is incomplete, diagnostic and retryable, even with plausible JSON',async t=>{
 t.mock.method(global,'fetch',async()=>response('error',0));const diagnostics=[];
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image,onDiagnostic:async d=>diagnostics.push(d)}),e=>e.code==='TRANSIENT_PROVIDER'&&e.retryKind==='provider'&&e.accounting.cost===0&&e.diagnostic.finish_reason==='error');
 assert.equal(diagnostics[1].error.error_type,'incomplete_generation');assert.match(diagnostics[1].response_excerpt,/No strict visible cue/);
});
test('23 saved regions are reused; only the unfinished region and its retry are sent',async t=>{
 const root=await fixture(t);await seed23(root);const sent=[];t.mock.method(global,'fetch',async(_u,o)=>{sent.push(JSON.parse(o.body));return response(sent.length===1?'error':'stop');});
 const engine=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{providerBaseMs:0}});await engine.run(options(root));
 assert.equal(engine.state.status,'complete');assert.equal(sent.length,2);assert.equal(engine.state.providerRetries,1);assert.equal(engine.state.failedRequests,1);assert.equal(engine.state.networkRetries,0);assert.equal(engine.state.formatRetries,0);assert.deepEqual(sent[0],sent[1]);
 assert.equal(engine.state.spend,.002);const [v]=(await S.loadLedger(root)).entries;assert.equal(v.verdict,'no');assert.equal(v.cards_total,6);assert.equal(v.cards_reviewed_count,6);
});
test('exhausted generation retries defer the affected video, finish other work, then reuse saved regions on recovery',async t=>{
 const root=await fixture(t,['1','2']);await seed23(root);let broken=0,other=0;const deferred=[];
 t.mock.method(global,'fetch',async(_u,o)=>{const p=JSON.parse(o.body),raw=Buffer.from(p.messages[1].content[1].image_url.url.split(',')[1],'base64').toString();if(raw.includes(path.join('frames','1'))&&++broken<=4)return response('error');other++;return response();});
 const engine=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{providerBaseMs:0},recoveryOptions:{baseMs:30,maxMs:30,pollMs:5}});engine.on('state',s=>{if(s.deferred?.length)deferred.push(s.deferred[0]);});await engine.run(options(root));
 assert.equal(engine.state.status,'complete');assert.equal(broken,5);assert.equal(other,25);assert.equal(engine.state.providerRetries,3);assert.ok(deferred.some(d=>d.recovery_kind==='provider'&&d.card==='card_5.jpg'&&d.region===1&&!d.manual));assert.deepEqual((await S.loadLedger(root)).entries.map(v=>v.id),['2','1']);
});
test('Pause during provider cooldown returns promptly with all saved coverage and no verdict',async t=>{
 const root=await fixture(t);const before=await seed23(root);let calls=0;t.mock.method(global,'fetch',async()=>{calls++;return response('error');});
 const engine=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{providerBaseMs:30000}});engine.on('state',s=>{if(s.providerRetries===1&&!engine.pauseRequested)engine.pause();});await engine.run(options(root));
 assert.equal(engine.state.status,'paused');assert.equal(calls,1);assert.equal((await S.loadLedger(root)).entries.length,0);assert.deepEqual((await S.readJson(path.join(root,'logs/reelsight_checkpoint.json'))).videos['1'].regions,before.regions);
});
test('content filter and explicit refusal override finish_reason error without retries',async t=>{
 for(const extra of [{choices:[{finish_reason:'error',native_finish_reason:'content_filter',message:{content:''}}]},{error:{code:503,message:'Failed'},choices:[{finish_reason:'error',message:{refusal:'Declined',content:''}}]},{choices:[{finish_reason:'error',error:{code:400,metadata:{error_type:'content_policy'},message:'Declined'},message:{content:''}}]}]){
 t.mock.method(global,'fetch',async()=>response('error',.003,extra));await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.videoBlocked&&!e.transient&&!e.fallbackMode&&e.accounting.cost===.003);t.mock.restoreAll();
 }
});
test('503 Retry-After is preserved, while authentication, credits and bad requests never become transient',async t=>{
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({error:{code:503,message:'Upstream unavailable'}}),{status:503,headers:{'Retry-After':'19'}}));await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.code==='TRANSIENT_PROVIDER'&&e.retryAfterMs===19000);t.mock.restoreAll();
 for(const code of [400,401,402,403,404]){t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({error:{code,message:'Request denied'}}),{status:code}));await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.status===code&&!e.transient);t.mock.restoreAll();}
});
test('provider HTTP 524 is a retryable timeout rather than a fatal review error',async t=>{
 t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({error:{code:524,message:'Provider returned error',metadata:{provider_name:'Alibaba'}}}),{status:524}));
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.code==='TRANSIENT_PROVIDER'&&e.retryKind==='provider'&&e.status===524&&e.provider==='Alibaba');
});
test('HTML gateway pages follow JSON status handling: 5xx retries, 429 throttles, 4xx stays fatal',async t=>{
 t.mock.method(global,'fetch',async()=>new Response('<!DOCTYPE html><title>Bad Gateway</title>',{status:502,headers:{'content-type':'text/html','Retry-After':'7'}}));
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.code==='TRANSIENT_PROVIDER'&&e.retryKind==='provider'&&e.status===502&&e.retryAfterMs===7000&&e.billingUncertain&&e.network.phase==='response-body');
 t.mock.restoreAll();
 t.mock.method(global,'fetch',async()=>new Response('<!DOCTYPE html>',{status:429,headers:{'Retry-After':'11'}}));
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.status===429&&!e.transient&&e.retryAfterMs===11000);
 t.mock.restoreAll();
 t.mock.method(global,'fetch',async()=>new Response('<!DOCTYPE html>',{status:401}));
 await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.status===401&&!e.transient&&e.code==='NETWORK_FAILURE'&&/unreadable response \(HTTP 401\)/.test(e.message));
});
test('HTML 502 retries only the unfinished region and does not count as a connection failure',async t=>{
 const root=await fixture(t);await seed23(root);let n=0;
 t.mock.method(global,'fetch',async()=>{n++;return n===1?new Response('<!DOCTYPE html><title>Bad Gateway</title>',{status:502}):response();});
 const engine=new ReviewEngine({prepareCard,reviewer:reviewImage,rateLimitOptions:{providerBaseMs:0}});await engine.run(options(root));
 assert.equal(engine.state.status,'complete');assert.equal(n,2);assert.equal(engine.state.providerRetries,1);assert.equal(engine.state.networkRetries,0);assert.equal(engine.state.failedRequests,1);
});
test('an embedded rate limit uses rate-limit handling, not generation retries',async t=>{
 t.mock.method(global,'fetch',async()=>response('error',0,{error:{code:429,message:'Limited',metadata:{error_type:'rate_limit_exceeded'}}}));await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>e.status===429&&!e.transient);
});

test('specific HTTP 400 media-download failures retry as provider errors while content refusals still take precedence',async t=>{
 for(const refused of [false,true]){
  t.mock.method(global,'fetch',async()=>new Response(JSON.stringify({error:{code:400,message:'Provider returned error',metadata:{provider_name:'Alibaba',raw:JSON.stringify({code:refused?'data_inspection_failed':'invalid_parameter_error',message:'Failed to download multimodal content'})}}}),{status:400}));
  await assert.rejects(()=>reviewImage({key:'LOCAL',model,image}),e=>refused?e.videoBlocked&&!e.transient:e.retryKind==='provider'&&e.transient&&e.status===400);
  t.mock.restoreAll();
 }
});
