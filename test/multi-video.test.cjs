const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {ReviewEngine}=require('../lib/engine.cjs'),{RequestGate}=require('../lib/request-gate.cjs'),S=require('../lib/storage.cjs');
const primary={id:'test/p',name:'Local synthetic model'},secondary={id:'test/s',name:'Independent synthetic model'};
const no={decision:'no',cue:'none',evidence:'No strict visual evidence in synthetic fixture.',location:'',confidence:.9,box:null,cost:.001};
const hit={...no,decision:'hit',cue:'synagogue_ark_bimah',evidence:'Visible Torah ark in the synthetic example.',location:'Center',box:[.2,.2,.3,.3]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<1200;n++){if(fn())return;await sleep(5);}assert.fail('Condition was not reached');}
async function fixture(t,videos=4,cards=5,regions=4){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-multi-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(let v=1;v<=videos;v++){const d=path.join(root,'frames',String(v),'cards');await fs.mkdir(d,{recursive:true});for(let c=1;c<=cards;c++)await fs.writeFile(path.join(d,`card_${c}.jpg`),`${v}:${c}`);}
 const prepareCard=async file=>Array.from({length:regions},(_,r)=>({mime:'image/png',data:`${path.basename(path.dirname(path.dirname(file)))}:${path.basename(file)}:${r}`,bounds:{x:0,y:0,width:10,height:10},imageSize:{width:10,height:10}}));
 return {root,prepareCard,options:{root,key:'SYNTHETIC',primary,workers:8,videoConcurrency:4,budget:20,dispatchMode:'concurrent'}};
}
test('multiple videos overlap, global slots are unique and simultaneous commits lose no verdicts',async t=>{
 const f=await fixture(t,8,5,4),seen=new Set();let peak=0,overlap=false;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async({image})=>{assert.ok(!seen.has(image.data));seen.add(image.data);await sleep(12);return no;}});
 e.on('state',s=>{peak=Math.max(peak,s.activeRequests);assert.ok(s.activeRequests<=8);assert.ok((s.videos||[]).length<=4);assert.equal(new Set(s.active.map(a=>a.worker)).size,s.active.length);if(new Set(s.active.map(a=>a.id)).size>1)overlap=true;});
 await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);assert.ok(overlap);assert.equal(peak,8);assert.equal(seen.size,160);
 const entries=(await S.loadLedger(f.root)).entries;assert.equal(entries.length,8);assert.ok(entries.every(v=>v.verdict==='no'&&v.cards_reviewed_count===5));assert.equal(e.state.done,8);assert.ok(Math.abs(e.state.spend-.16)<1e-9);assert.deepEqual((await S.readJson(path.join(f.root,'logs/reelsight_checkpoint.json'))).videos,{});
});
test('128 is a global request ceiling across four videos, including independent verification',async t=>{
 const f=await fixture(t,4,8,4);let active=0,peak=0,release;const seen=new Set(),ids=new Set(),barrier=new Promise(r=>{release=r;});
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async({image,model})=>{active++;peak=Math.max(peak,active);assert.ok(active<=128);const id=image.data+'/'+model.id;assert.ok(!seen.has(id));seen.add(id);ids.add(image.data.split(':')[0]);if(seen.size===128)release();await barrier;await sleep(8);active--;return no;}});
 await e.run({...f.options,workers:128,secondary,verificationMode:'all'});assert.equal(e.state.status,'complete',e.state.message);assert.equal(peak,128);assert.equal(seen.size,256);assert.equal(ids.size,4);assert.equal((await S.loadLedger(f.root)).entries.length,4);
});
test('a hit cancels only its own video; all regions of the other video finish',async t=>{
 const f=await fixture(t,2,10,2),calls={};const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async({image})=>{const id=image.data.split(':')[0];calls[id]=(calls[id]||0)+1;await sleep(id==='1'?12:25);return id==='1'?hit:no;}});
 await e.run({...f.options,workers:4,videoConcurrency:2});assert.equal(e.state.status,'complete',e.state.message);assert.ok(calls['1']<=4);assert.equal(calls['2'],20);const entries=(await S.loadLedger(f.root)).entries;assert.equal(entries.find(v=>v.id==='1').verdict,'jewish');assert.equal(entries.find(v=>v.id==='2').cards_reviewed_count,10);
});
test('pause drains every video, retains all saved regions, and resume never resends them',async t=>{
 const f=await fixture(t,3,12,2),seen=new Set();let overlaps=false;
 const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async({image})=>{assert.ok(!seen.has(image.data));seen.add(image.data);await sleep(30);return no;}});
 e.on('state',s=>{if(!overlaps&&new Set(s.active.map(a=>a.id)).size>=2){overlaps=true;e.pause();}});
 await e.run({...f.options,workers:4,videoConcurrency:3});assert.ok(overlaps);assert.equal(e.state.status,'paused');assert.equal(e.state.activeRequests,0);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 const cp=await S.readJson(path.join(f.root,'logs/reelsight_checkpoint.json'));assert.equal(Object.values(cp.videos).reduce((n,v)=>n+Object.keys(v.regions).length,0),seen.size);
 await e.run({...f.options,workers:4,videoConcurrency:3});assert.equal(e.state.status,'complete',e.state.message);assert.equal(seen.size,72);assert.equal((await S.loadLedger(f.root)).entries.length,3);
});
test('same pixels have a single concurrent owner and aliases copy its verdict',async t=>{
 const f=await fixture(t,4,3,2);for(const id of ['2','3'])for(let c=1;c<=3;c++)await fs.copyFile(path.join(f.root,'frames','1','cards',`card_${c}.jpg`),path.join(f.root,'frames',id,'cards',`card_${c}.jpg`));
 let calls=0;const e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;await sleep(15);return no;}});await e.run({...f.options,workers:4});
 assert.equal(e.state.status,'complete',e.state.message);assert.equal(calls,12);const entries=(await S.loadLedger(f.root)).entries;assert.equal(entries.length,4);assert.equal(entries.filter(v=>v.method==='shared-reel-copy').length,2);
});
test('global budget and fatal journal errors stop sends across all active videos',async t=>{
 for(const fatal of [false,true]){
 const f=await fixture(t,3,12,2);let e,failed=false,calls=0;const releases=[];
 e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>{calls++;return new Promise(resolve=>releases.push(()=>resolve({...no,cost:1})));}});
 const account=e.account.bind(e);if(fatal)e.account=async result=>{if(!failed){failed=true;throw new Error('Synthetic journal unavailable');}return account(result);};
 const run=e.run({...f.options,workers:4,budget:.5});await until(()=>releases.length===4);releases[0]();await until(()=>fatal?!!e.stopError:e.pauseRequested);for(const release of releases.slice(1))release();await run;
 assert.equal(calls,4);assert.equal(e.state.activeRequests,0);assert.equal(e.state.status,fatal?'error':'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);
 }
});
test('Take turns is globally serial across videos and retries retain the same slot',async t=>{
 const f=await fixture(t,3,2,1),sequence=[];let active=0,peak=0,failed=false;
 const e=new ReviewEngine({prepareCard:f.prepareCard,rateLimitOptions:{spacingMs:0,baseDelayMs:1,maxDelayMs:1},reviewer:async({image})=>{sequence.push(image.data);peak=Math.max(peak,++active);await sleep(4);active--;if(!failed){failed=true;throw Object.assign(new Error('Synthetic throttle'),{status:429});}return no;}});
 await e.run({...f.options,workers:8,dispatchMode:'one-at-a-time'});assert.equal(e.state.status,'complete',e.state.message);assert.equal(peak,1);assert.equal(sequence.length,7);assert.equal(sequence[0],sequence[1]);assert.equal((await S.loadLedger(f.root)).entries.length,3);
});
test('fair requests rotate among three waiting videos without starving the third',async()=>{
 const gate=new RequestGate({workers:1,mode:'concurrent',sleep:()=>sleep(1)}),held=await gate.acquire(()=>false,'start'),order=[];
 const jobs=[];for(let i=0;i<3;i++)for(const owner of ['a','b','c'])jobs.push(gate.acquire(()=>false,owner).then(release=>{order.push(owner);release();}));held();await Promise.all(jobs);assert.deepEqual(order,['a','b','c','a','b','c','a','b','c']);
});
test('invalid video concurrency is rejected before work starts',async t=>{
 const f=await fixture(t,1,1,1),e=new ReviewEngine({prepareCard:f.prepareCard,reviewer:async()=>assert.fail()});for(const value of [0,17,1.5,NaN])await assert.rejects(e.run({...f.options,videoConcurrency:value}),/videos at once/);assert.equal(e.running,false);
});
test('newly published videos enter empty slots while an older video still has in-flight requests',async t=>{
 const f=await fixture(t,1,8,1),releases=[];let producing=true,calls=0;
 const e=new ReviewEngine({prepareCard:f.prepareCard,recoveryOptions:{pollMs:5},reviewer:async({image})=>{calls++;if(image.data.startsWith('2:'))producing=false;if(calls<=4)return new Promise(r=>releases.push(()=>r(no)));return no;}});
 const run=e.run({...f.options,workers:4,videoConcurrency:2,followPreparation:()=>producing});await until(()=>releases.length===4);
 const dir=path.join(f.root,'frames','2','cards');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'card_1.jpg'),'new footage');
 await until(()=>e.state.videos.some(v=>v.id==='2'));assert.equal((await S.loadLedger(f.root)).entries.length,0);releases.forEach(r=>r());await run;assert.equal(e.state.status,'complete',e.state.message);assert.equal((await S.loadLedger(f.root)).entries.length,2);
});
