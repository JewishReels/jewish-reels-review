const wire = ({cost,model,...value}) => value;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReviewEngine } = require('../lib/engine.cjs');
const { reviewImage } = require('../lib/openrouter.cjs');
const { parseContent } = require('../lib/openrouter.cjs');
const S = require('../lib/storage.cjs');
const primary = { id: 'test/p', name: 'Primary', architecture:{input_modalities:['image'],output_modalities:['text']}, supported: [], pricing: {} };
const secondary = { ...primary, id: 'test/s', name: 'Secondary' };
const no = { decision: 'no', cue: 'none', evidence: 'No strict visible cue.', location: '', confidence: .8, box: null, cost: .01 };
const hit = { decision: 'hit', cue: 'synagogue_ark_bimah', evidence: 'Torah ark visible in the center.', location: 'Center', confidence: .9, box: [.2,.2,.3,.3], cost: .01 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, cards = 6, regions = 2) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reelsight-workers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'frames', '1', 'cards');
  await fs.mkdir(dir, { recursive: true });
  for (let i=1;i<=cards;i++) await fs.writeFile(path.join(dir, `card_${i}.jpg`), String(i));
  const prepareCard = async file => Array.from({length:regions}, (_,r) => ({ data: `${path.basename(file)}:${r}`, mime: 'image/png', bounds: {x:r*10,y:0,width:10,height:10}, imageSize: {width:regions*10,height:10} }));
  return { root, prepareCard, options: {root, key:'MOCK', primary, workers:4, budget:100} };
}
test('four queued workers serialize complete independent reviews and save each result before the next region',async t=>{
 const f=await fixture(t,3,2);let active=0,peak=0;const seen=[],states=[];
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async({image,model})=>{
  peak=Math.max(peak,++active);const id=image.data+'/'+model.id;assert.ok(!seen.includes(id));seen.push(id);
  if(seen.length>2){const cp=await S.readJson(path.join(f.root,'logs','reelsight_checkpoint.json'));assert.ok(Object.keys(cp.videos['1'].regions).length>=1);}
  await delay(10);active--;return no;
 }});
 e.on('state',s=>states.push(s));await e.run({...f.options,secondary});
 assert.equal(e.state.status,'complete');assert.equal(peak,1);assert.equal(seen.length,12);assert.equal(e.state.rateLimit.effectiveWorkers,1);
 for(let i=0;i<seen.length;i+=2)assert.equal(seen[i].split('/test/')[0],seen[i+1].split('/test/')[0]);
 assert.ok(states.some(s=>s.active.length===1));assert.ok(states.every(s=>s.active.length<=1));
 const v=(await S.loadLedger(f.root)).entries[0];assert.equal(v.cards_reviewed_count,3);assert.equal(v.verdict,'no');assert.ok(Math.abs(e.state.spend-.12)<1e-9);
});

async function until(predicate) { for(let i=0;i<500;i++){if(predicate())return;await delay(5);}assert.fail('Condition was not reached'); }

function connectionFailure(){return require('../lib/network.cjs').connectionError(new TypeError('fetch failed',{cause:Object.assign(new Error('Socket reset'),{code:'ECONNRESET'})}));}
test('a network failure at 64 workers retries only the missing image without pausing siblings',async t=>{
 const f=await fixture(t,65,1),releases=[],starts=[];let calls=0,failedAt=0;
 const e=new ReviewEngine({rateLimitOptions:{networkBaseMs:200},prepareCard:f.prepareCard,reviewer:async({image})=>{const n=++calls;starts.push({image:image.data,at:Date.now()});if(n<=64)return new Promise((resolve,reject)=>releases.push(()=>{if(n===1){failedAt=Date.now();reject(connectionFailure());}else resolve(no);}));return no;}});
 const run=e.run({...f.options,workers:64,dispatchMode:'concurrent'});await until(()=>releases.length===64);releases[0]();await until(()=>e.state.networkRetries===1);for(const release of releases.slice(1))release();
 await until(()=>calls>=65);assert.ok(starts[64].at<failedAt+200,'The next region must not wait for the failed image backoff');
 await run;
 assert.equal(e.state.status,'complete');assert.equal(calls,66);assert.equal(e.state.rateLimit.effectiveWorkers,64);
 const retry=starts.find((s,i)=>i>0&&s.image===starts[0].image);assert.ok(retry.at>=failedAt+200);
 assert.equal(starts.filter(s=>s.image===starts[0].image).length,2);assert.equal(e.state.retries,0);assert.equal((await S.loadLedger(f.root)).entries[0].cards_reviewed_count,65);
});
test('a provider retry waits on that image only and does not pause sibling workers',async t=>{
 const f=await fixture(t,3,1),starts=[];let failedAt=0;
 const e=new ReviewEngine({rateLimitOptions:{providerBaseMs:80},prepareCard:f.prepareCard,reviewer:async({image})=>{
  starts.push({image:image.data,at:Date.now()});
  if(starts.filter(s=>s.image===image.data).length===1&&!failedAt){failedAt=Date.now();throw Object.assign(new Error('incomplete'),{transient:true,retryKind:'provider'});}
  return no;
 }});
 await e.run({...f.options,workers:3,dispatchMode:'concurrent'});
 assert.equal(e.state.status,'complete');assert.equal(e.state.providerRetries,1);
 const retry=starts.find((s,i)=>i>0&&s.image===starts[0].image);assert.ok(retry.at>=failedAt+80);
 const sibling=starts.find((s,i)=>i>0&&s.image!==starts[0].image);assert.ok(sibling.at<failedAt+80);
});

test('three connection retries defer only that video and resume keeps completed cards',async t=>{
 const f=await fixture(t,2,1);let calls=0;
 const e=new ReviewEngine({rateLimitOptions:{networkBaseMs:1,spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{if(++calls===1)return no;throw connectionFailure();}});
 const pauseOnDeferred=s=>{if(s.deferred?.some(v=>v.id==='1'&&v.recovery_kind==='network'))e.pauseRequested=true;};e.on('state',pauseOnDeferred);
 await e.run({...f.options,workers:1});assert.equal(e.state.status,'paused');assert.equal(calls,5);assert.equal(e.state.networkRetries,3);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 e.off('state',pauseOnDeferred);
 e.reviewer=async()=>{calls++;return no;};await e.run({...f.options,workers:1});assert.equal(calls,6);assert.equal(e.state.status,'complete');
});

test('pause interrupts connection backoff and leaves the region unfinished',async t=>{
 const f=await fixture(t,1,1);let calls=0;const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;throw connectionFailure();}});
 e.on('state',s=>{if(s.networkRetries)e.pauseRequested=true;});await e.run({...f.options,workers:64,dispatchMode:'concurrent'});assert.equal(calls,1);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
});

test('64 workers save all in-flight results on pause and resume with persistent spend and one completed video',async t=>{
 const f=await fixture(t,65,1),releases=[];let calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(no)));}});
 const run=e.run({...f.options,workers:64,dispatchMode:'concurrent'});await until(()=>releases.length===64);await delay(30);assert.equal(calls,64);
 e.pause();for(const release of releases)release();await run;assert.equal(e.state.status,'paused');assert.equal(e.state.sessionVideos,0);assert.ok(Math.abs(e.state.totalSpend-.64)<1e-9);
 const resumed=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;return no;}});
 await resumed.run({...f.options,workers:64,dispatchMode:'concurrent'});assert.equal(resumed.state.status,'complete');assert.equal(calls,65);assert.equal(resumed.state.spend,.01);assert.ok(Math.abs(resumed.state.totalSpend-.65)<1e-9);assert.equal(resumed.state.sessionVideos,1);assert.ok(resumed.state.videosPerMinute>0);
});

test('a hit with 64 requests in flight stops the 65th and retains every response cost',async t=>{
 const f=await fixture(t,65,1),releases=[];let calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{const n=++calls;return new Promise(resolve=>releases.push(()=>resolve(n===1?hit:no)));}});
 const run=e.run({...f.options,workers:64,dispatchMode:'concurrent'});await until(()=>releases.length===64);releases[0]();await until(()=>e.state.message.includes('strict hit found'));
 assert.equal((await S.loadLedger(f.root)).entries.length,0);for(const release of releases.slice(1))release();await run;
 assert.equal(calls,64);assert.equal(e.state.status,'complete');assert.ok(Math.abs(e.state.totalSpend-.64)<1e-9);assert.equal(e.state.sessionVideos,1);const saved=(await S.loadLedger(f.root)).entries[0];assert.equal(saved.verdict,'jewish');assert.equal(saved.evidence_hits.length,1);
});

test('all accepted hits already in flight are retained on one video',async t=>{
 const f=await fixture(t,8,1),releases=[];let calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{const n=++calls;return new Promise(resolve=>releases.push(()=>resolve(n<=3?{...hit,cue:n===2?'judaica':hit.cue,evidence:`Accepted visible cue ${n} in this image region.`}:no)));}});
 const run=e.run({...f.options,workers:4,dispatchMode:'concurrent'});await until(()=>releases.length===4);releases[0]();await until(()=>e.state.message.includes('strict hit found'));for(const release of releases.slice(1))release();await run;
 const saved=(await S.loadLedger(f.root)).entries[0];assert.equal(calls,4);assert.equal(saved.evidence_hits.length,3);assert.deepEqual(saved.cues.sort(),['judaica','synagogue_ark_bimah']);assert.equal(saved.evidence.card,saved.evidence_hits[0].card);
});

test('concurrent mode overlaps four workers, with independent verification and complete unique coverage',async t=>{
 const f=await fixture(t,4,2);let active=0,peak=0;const seen=new Set();
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async({image,model})=>{
  peak=Math.max(peak,++active);const id=image.data+'/'+model.id;assert.ok(!seen.has(id));seen.add(id);await delay(25);active--;return no;
 }});
 await e.run({...f.options,dispatchMode:'concurrent',secondary});assert.equal(e.state.status,'complete');assert.equal(peak,4);assert.equal(seen.size,16);assert.equal(e.state.rateLimit.spacingMs,0);
 const v=(await S.loadLedger(f.root)).entries[0];assert.equal(v.cards_reviewed_count,4);assert.equal(v.dispatch_mode,'concurrent');assert.equal(v.verdict,'no');assert.ok(Math.abs(e.state.spend-.16)<1e-9);
});

test('switching from concurrent to take-turns after pause reuses all four in-flight saved primaries',async t=>{
 const f=await fixture(t,8,1),releases=[];let calls=0;
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve(no)));}});
 const run=e.run({...f.options,dispatchMode:'concurrent',secondary});await until(()=>releases.length===4);e.pause();for(const r of releases)r();await run;
 assert.equal(e.state.status,'paused');assert.equal(calls,4);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 const cp=await S.readJson(path.join(f.root,'logs/reelsight_checkpoint.json'));assert.equal(Object.keys(cp.videos['1'].regions).length,4);
 let active=0,peak=0;e.reviewer=async()=>{calls++;peak=Math.max(peak,++active);await delay(5);active--;return no;};await e.run({...f.options,dispatchMode:'one-at-a-time',secondary});
 assert.equal(e.state.status,'complete');assert.equal(peak,1);assert.equal(calls,16);
});

test('a concurrent hit prevents new work and waits for existing requests before saving the verdict',async t=>{
 const f=await fixture(t,10,1),releases=[];let calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{const n=++calls;return new Promise(resolve=>releases.push(()=>resolve(n===1?hit:no)));}});
 const run=e.run({...f.options,dispatchMode:'concurrent'});await until(()=>releases.length===4);releases[0]();await until(()=>e.state.message.includes('strict hit found'));
 await delay(20);assert.equal(calls,4);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 for(const r of releases.slice(1))r();await run;assert.equal(calls,4);assert.equal((await S.loadLedger(f.root)).entries[0].verdict,'jewish');assert.equal(e.state.activeRequests,0);assert.equal(e.state.spend,.04);
});

test('concurrent budget stop saves in-flight work and starts no further requests',async t=>{
 const f=await fixture(t,10,1),releases=[];let calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve({...no,cost:1})));}});
 const run=e.run({...f.options,dispatchMode:'concurrent',budget:.5});await until(()=>releases.length===4);releases[0]();await until(()=>e.pauseRequested);for(const r of releases.slice(1))r();await run;
 assert.equal(calls,4);assert.equal(e.state.status,'paused');assert.equal(e.state.spend,4);assert.equal((await S.loadLedger(f.root)).entries.length,0);
});

test('concurrent throttling delays the failed image while healthy workers continue',async t=>{
 const f=await fixture(t,8,1),starts=[],releases=[];let calls=0;
 const e=new ReviewEngine({rateLimitOptions:{baseDelayMs:2000,maxDelayMs:2000},prepareCard:f.prepareCard,reviewer:async({image})=>{
  const n=++calls;starts.push({image:image.data});if(n<=4)return new Promise((resolve,reject)=>releases.push(()=>{if(n===1)reject(Object.assign(new Error('Throttle'),{status:429}));else resolve(no);}));return no;
 }});
 const run=e.run({...f.options,dispatchMode:'concurrent'});await until(()=>releases.length===4);releases[0]();await until(()=>e.state.retries===1);for(const r of releases.slice(1))r();await until(()=>starts.slice(4).some(r=>r.image!==starts[0].image));assert.equal(starts.filter(r=>r.image===starts[0].image).length,1);await run;
 const failedImageStarts=starts.filter(r=>r.image===starts[0].image);
 const healthyStart=starts.findIndex((r,i)=>i>=4&&r.image!==starts[0].image),retryStart=starts.findIndex((r,i)=>i>=4&&r.image===starts[0].image);
 assert.equal(e.state.status,'complete');assert.equal(calls,9);assert.ok(healthyStart>=4);assert.ok(retryStart>healthyStart);assert.equal(failedImageStarts.length,2);
});

test('invalid scheduling modes are rejected before running',async t=>{
 const f=await fixture(t,1);const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>assert.fail('No call expected')});
 await assert.rejects(()=>e.run({...f.options,dispatchMode:'unknown'}),/Take turns/);assert.equal(e.running,false);
});

test('first hit stops every queued worker before another request starts',async t=>{
 const f=await fixture(t,12,1);let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>++calls===2?hit:no});
 await e.run(f.options);const v=(await S.loadLedger(f.root)).entries[0];
 assert.equal(calls,2);assert.equal(v.verdict,'jewish');assert.equal(v.evidence.card,'card_2.jpg');assert.equal(v.cards_reviewed_count,2);assert.equal(e.state.spend,.02);
});

test('pause saves the single in-flight primary and cancels queued workers; resume reuses it',async t=>{
 const f=await fixture(t,6,1);let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;e.pause();return no;}});
 await e.run({...f.options,secondary});assert.equal(calls,1);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
 const cp=await S.readJson(path.join(f.root,'logs','reelsight_checkpoint.json'));assert.equal(Object.values(cp.videos['1'].regions).filter(r=>r.primary).length,1);
 e.reviewer=async()=>{calls++;return no;};await e.run({...f.options,secondary,workers:2});assert.equal(calls,12);assert.equal(e.state.status,'complete');
});

test('a failed worker blocks every queued request and retains preceding successes for resume',async t=>{
 const f=await fixture(t,8,1);let calls=0;
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{if(++calls===2)throw new Error('Network failure');return no;}});
 await e.run(f.options);assert.equal(e.state.status,'error');assert.equal(calls,2);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 const cp=await S.readJson(path.join(f.root,'logs','reelsight_checkpoint.json'));assert.equal(Object.keys(cp.videos['1'].regions).length,1);
 e.reviewer=async()=>{calls++;return no;};await e.run(f.options);assert.equal(calls,9);assert.equal((await S.loadLedger(f.root)).entries[0].cards_reviewed_count,8);
});

test('one response reaching the budget blocks all queued workers',async t=>{
 const f=await fixture(t,10,1);let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;return{...no,cost:1};}});
 await e.run({...f.options,budget:.5});assert.equal(calls,1);assert.equal(e.state.spend,1);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
});

test('429 retries after a shared cooldown without skipping coverage or using another model', async t => {
  const f=await fixture(t,1,1);let calls=0,failedAt=0;const times=[];
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,rateLimitOptions:{baseDelayMs:20,spacingMs:5},reviewer:async({model})=>{
    assert.equal(model.id,primary.id);times.push(Date.now());
    if(++calls===1){failedAt=Date.now();throw Object.assign(new Error('Rate limit'),{status:429,retryAfterMs:1100});}return no;
  }});
  await e.run(f.options);assert.ok(times[1]-failedAt>=1100);assert.equal(calls,2);assert.equal(e.state.retries,1);assert.equal((await S.loadLedger(f.root)).entries[0].verdict,'no');
});
test('pause interrupts a long rate-limit cooldown promptly without dispatching again', async t => {
  const f=await fixture(t,2,1);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;throw Object.assign(new Error('Rate limit'),{status:429,retryAfterMs:60000});}});
  e.on('state',s=>{if(s.retries)e.pauseRequested=true;});
  await e.run({...f.options,workers:1});assert.equal(e.state.status,'paused');assert.equal(calls,1);assert.equal((await S.loadLedger(f.root)).entries.length,0);
});
test('invalid worker counts are rejected before the reviewer is called',async t=>{
  const f=await fixture(t,1);const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>assert.fail('No call expected')});
  for(const workers of [0,129,2.5,NaN])await assert.rejects(()=>e.run({...f.options,workers}),/workers/);
});
test('API adapter exposes rate-limit status, Retry-After and any billed usage',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);
  global.fetch=async()=>({ok:false,status:429,headers:new Headers({'Retry-After':'7'}),json:async()=>({error:{code:429,message:'Throttled'},usage:{cost:.02},id:'mock-generation'})});
  await assert.rejects(()=>reviewImage({key:'MOCK',model:primary,image:{data:'PIXELS',mime:'image/png'}}),e=>e.status===429&&e.retryAfterMs===7000&&e.accounting.cost===.02);
});

test('rate-limited image retains queue ownership until success, including verifier retries',async t=>{
 const f=await fixture(t,4,1),sequence=[],times=[],ends=[];let failures=0,active=0,peak=0;
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,rateLimitOptions:{baseDelayMs:25,maxDelayMs:30,spacingMs:15},reviewer:async({image,model})=>{
  const key=image.data+'/'+model.id;sequence.push(key);times.push(Date.now());peak=Math.max(peak,++active);await delay(20);active--;ends.push(Date.now());
  if(model.id===secondary.id&&failures++<2)throw Object.assign(new Error('Throttle'),{status:429});return no;
 }});
 await e.run({...f.options,secondary});assert.equal(e.state.status,'complete');assert.equal(peak,1);assert.equal(e.state.retries,2);
 assert.deepEqual(sequence.slice(0,5),['card_1.jpg:0/test/p','card_1.jpg:0/test/s','card_1.jpg:0/test/s','card_1.jpg:0/test/s','card_2.jpg:0/test/p']);
 for(let i=1;i<times.length;i++)assert.ok(times[i]-ends[i-1]>=14,'A new send must follow the previous completion gap');
 assert.equal((await S.loadLedger(f.root)).entries[0].cards_reviewed_count,4);
});

test('six 429 retries exhaust safely and resume reuses the preceding completed card',async t=>{
  const f=await fixture(t,2,1);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,rateLimitOptions:{baseDelayMs:1,maxDelayMs:2,spacingMs:1},reviewer:async()=>{
    if(++calls===1)return no;throw Object.assign(new Error('Throttle'),{status:429});
  }});
  await e.run({...f.options,workers:1});assert.equal(e.state.status,'error');assert.equal(calls,8);assert.match(e.state.message,/Six automatic retries/);
  assert.equal((await S.loadLedger(f.root)).entries.length,0);
  const cp=await S.readJson(path.join(f.root,'logs','reelsight_checkpoint.json'));assert.deepEqual(cp.videos['1'].completedCards,['card_1.jpg']);
  e.reviewer=async()=>{calls++;return no;};await e.run({...f.options,workers:1});assert.equal(calls,9);assert.equal(e.state.status,'complete');
});

test('a provider wait longer than ten minutes stops without an early retry or a no verdict',async t=>{
  const f=await fixture(t,1,1);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;throw Object.assign(new Error('Daily limit'),{status:429,retryAfterMs:3600000});}});
  await e.run({...f.options,workers:1});assert.equal(calls,1);assert.equal(e.state.status,'error');assert.match(e.state.message,/3600 seconds/);assert.equal((await S.loadLedger(f.root)).entries.length,0);
});

test('backup providers retain the selected model and required visual response parameters',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);let payload;
  global.fetch=async(_url,opts)=>{payload=JSON.parse(opts.body);return{ok:true,json:async()=>({usage:{cost:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire(no))}}]})};};
  await reviewImage({key:'MOCK',model:{...primary,supported:['structured_outputs']},image:{data:'PIXELS',mime:'image/png'}});
  assert.equal(payload.model,primary.id);assert.equal(payload.provider.allow_fallbacks,true);assert.equal(payload.provider.require_parameters,true);assert.equal(payload.response_format.type,'json_schema');assert.equal(payload.models,undefined);
});

test('HTTP date Retry-After and sanitized provider details survive the adapter',async t=>{
  const original=global.fetch;t.after(()=>global.fetch=original);
  const deadline=Math.floor(Date.now()/1000)*1000+30000;
  global.fetch=async()=>({ok:false,status:429,headers:new Headers({'Retry-After':new Date(deadline).toUTCString()}),json:async()=>({error:{code:429,message:'Throttled sk-or-secret-example',metadata:{provider_name:'Mock provider'}}})});
  await assert.rejects(()=>reviewImage({key:'MOCK',model:primary,image:{data:'PIXELS',mime:'image/png'}}),e=>e.status===429&&e.retryAfterMs>28000&&e.retryAfterMs<=30000&&e.provider==='Mock provider'&&!e.providerMessage.includes('sk-or-'));
});
test('contradictory no remains invalid and preserves rejected final answer for diagnosis',()=>{
  const raw=JSON.stringify({...wire(no),cue:'judaica',box:[0,0,1,1]});
  assert.throws(()=>parseContent(raw),e=>e.code==='INVALID_VISUAL_RESULT'&&e.invalidResponse===raw);
});
function invalidAnswer(){return Object.assign(new Error('Invalid model result: Model returned contradictory no/hit evidence.'),{code:'INVALID_VISUAL_RESULT',invalidResponse:'{"decision":"no","cue":"judaica"}',accounting:{cost:.02}});}

test('candidate-hit verification rejects an unconfirmed logo-like candidate and finishes every card',async t=>{
  const f=await fixture(t,3,1),calls=[];
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async args=>{calls.push(args);return args.model.id===primary.id&&args.image.data.startsWith('card_2.')?hit:no;}});
  await e.run({...f.options,workers:1,secondary,verificationMode:'positives'});
  assert.deepEqual(calls.map(c=>c.model.id),[primary.id,primary.id,secondary.id,primary.id]);
  const entry=(await S.loadLedger(f.root)).entries[0];assert.equal(entry.verdict,'no');assert.equal(entry.cards_reviewed_count,3);assert.equal(entry.verification_mode,'positives');assert.equal(entry.uncorroborated_regions,1);
  assert.equal(calls[2].image,calls[1].image);assert.ok(!Object.hasOwn(calls[2],'primary'));
});

test('candidate verifier failure leaves the reel unfinished; resume reuses the primary before accepting a hit',async t=>{
  const f=await fixture(t,1,1);let primaries=0,verifiers=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async({model})=>{if(model.id===primary.id){primaries++;return hit;}if(++verifiers===1)throw new Error('Verifier unavailable');return hit;}});
  const options={...f.options,secondary,verificationMode:'positives'};
  await e.run(options);assert.equal(e.state.status,'error');assert.equal((await S.loadLedger(f.root)).entries.length,0);
  await e.run(options);assert.equal(primaries,1);assert.equal(verifiers,2);assert.equal((await S.loadLedger(f.root)).entries[0].verdict,'jewish');
});
test('invalid result is reread with identical pixels; only validated answers count toward coverage',async t=>{
  const f=await fixture(t,2,1);const calls=[];
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async args=>{calls.push(args);if(calls.length===1)throw invalidAnswer();return no;}});
  await e.run({...f.options,workers:1});assert.equal(calls.length,3);assert.equal(calls[0].formatRetry,false);assert.equal(calls[1].formatRetry,true);assert.equal(calls[0].image,calls[1].image);assert.equal(calls[0].model,calls[1].model);
  assert.equal(e.state.status,'complete');assert.equal(e.state.formatRetries,1);assert.equal(e.state.requests,3);assert.equal(e.state.spend,.04);
  const ledger=(await S.loadLedger(f.root)).entries;assert.equal(ledger[0].cards_reviewed_count,2);
  const log=(await fs.readFile(path.join(f.root,'logs','reelsight_reviews.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(log[0].rejected_response,invalidAnswer().invalidResponse);
});
test('two invalid-result retries isolate the video, retain completed cards and resume only failed image',async t=>{
  const f=await fixture(t,2,1);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},recoveryOptions:{baseMs:20,maxMs:20,pollMs:5},prepareCard:f.prepareCard,reviewer:async()=>{calls++;if(calls>1)throw invalidAnswer();return no;}});
  const stopAfterDefer=s=>{if(s.deferred?.some(d=>d.recovery_kind==='provider')&&!e.pauseRequested){e.off('state',stopAfterDefer);e.pause();}};
  e.on('state',stopAfterDefer);
  await e.run({...f.options,workers:1});assert.equal(calls,4);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
  const cp=await S.readJson(path.join(f.root,'logs','reelsight_checkpoint.json'));assert.deepEqual(cp.videos['1'].completedCards,['card_1.jpg']);assert.equal(Object.keys(cp.videos['1'].regions).length,1);
  e.reviewer=async()=>{calls++;return no;};await e.run({...f.options,workers:4});assert.equal(calls,5);assert.equal(e.state.status,'complete');
});
test('a content refusal on one region does not turn a sibling format error into a session stop',async t=>{
  const f=await fixture(t,2,1);let calls=0;
  const blocked=Object.assign(new Error('Alibaba declined this image (data_inspection_failed).'),{code:'PROVIDER_CONTENT_REJECTED',videoBlocked:true,status:400});
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;if(calls===1)throw blocked;if(calls===2)throw invalidAnswer();return no;}});
  await e.run({...f.options,workers:2,dispatchMode:'concurrent'});
  assert.equal(e.state.status,'attention');assert.equal((await S.loadLedger(f.root)).entries.length,0);
  const pending=(await S.readJson(path.join(f.root,'logs','reelsight_deferred.json'))).videos[0];assert.equal(pending.manual,true);assert.equal(pending.id,'1');
});
test('budget can stop an invalid-result retry before another paid request',async t=>{
  const f=await fixture(t,1,1);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async()=>{calls++;throw invalidAnswer();}});
  await e.run({...f.options,workers:1,budget:.01});assert.equal(calls,1);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
});
test('failed verifier format retry reuses primary and does not share primary evidence',async t=>{
  const f=await fixture(t,1,1);const calls=[];
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:async args=>{calls.push(args);if(calls.length===2)throw invalidAnswer();return {...hit,model:args.model.id};}});
  await e.run({...f.options,secondary});assert.deepEqual(calls.map(c=>c.model.id),[primary.id,secondary.id,secondary.id]);assert.equal(calls[2].formatRetry,true);assert.ok(!Object.hasOwn(calls[2],'primary'));assert.equal((await S.loadLedger(f.root)).entries[0].verdict,'jewish');
});
test('repair prompt resends image and preserves billing; refusals are not format retries',async t=>{
  const old=global.fetch;t.after(()=>global.fetch=old);let payload;
  global.fetch=async(_url,opts)=>{payload=JSON.parse(opts.body);return{ok:true,json:async()=>({usage:{cost:.03},choices:[{finish_reason:'stop',message:{content:JSON.stringify(wire(no))}}]})};};
  const result=await reviewImage({key:'MOCK',model:primary,image:{mime:'image/png',data:'EXACT_PIXELS'},formatRetry:true});assert.equal(result.cost,.03);assert.match(payload.messages[1].content[0].text,/Independently re-inspect/);assert.ok(payload.messages[1].content[1].image_url.url.endsWith('EXACT_PIXELS'));
  global.fetch=async()=>({ok:true,json:async()=>({usage:{cost:.01},choices:[{finish_reason:'stop',message:{refusal:'Refused'}}]})});
  await assert.rejects(()=>reviewImage({key:'MOCK',model:primary,image:{mime:'image/png',data:'EXACT_PIXELS'}}),e=>e.code!=='INVALID_VISUAL_RESULT'&&e.accounting.cost===.01);
});

test('provider format fallback retains pixels, validates retries, caches mode, and accounts once',async t=>{
 const f=await fixture(t,2,1),before=global.fetch;t.after(()=>global.fetch=before);const sent=[];
 global.fetch=async(_url,opts)=>{
  const payload=JSON.parse(opts.body);sent.push(payload);
  if(sent.length===1)return{ok:false,status:400,json:async()=>({error:{code:400,message:'json_schema is not supported'}})};
  const content=sent.length===2?{...wire(no),box:'null'}:wire(no);
  return{ok:true,status:200,json:async()=>({id:'generation-'+sent.length,usage:{cost:.01},choices:[{finish_reason:'stop',message:{content:JSON.stringify(content)}}]})};
 };
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:f.prepareCard,reviewer:reviewImage});
 await e.run({...f.options,workers:1,primary:{...primary,supported:['structured_outputs','response_format']}});
 assert.equal(e.state.status,'complete');assert.equal(sent.length,4);assert.equal(e.state.formatRetries,1);assert.equal(e.state.attempts,4);assert.equal(e.state.requests,3);assert.equal(e.state.spend,.03);
 assert.deepEqual(sent.map(p=>p.response_format.type),['json_schema','json_object','json_object','json_object']);
 assert.equal(sent[0].messages[1].content[1].image_url.url,sent[2].messages[1].content[1].image_url.url);
 assert.match(sent[2].messages[1].content[0].text,/cue must be exactly/);
 assert.equal((await S.loadLedger(f.root)).entries[0].cards_reviewed_count,2);
});
