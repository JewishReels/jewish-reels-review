const wire = ({cost,model,...value}) => value;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReviewEngine, createCheckpointSaver } = require('../lib/engine.cjs');
const S = require('../lib/storage.cjs');

test('a checkpoint waiter resolves after its own durable revision while newer progress keeps writing',async()=>{
  const releases=[];let checkpoint={step:1};
  const save=createCheckpointSaver('checkpoint.json',()=>checkpoint,{delayMs:0,atomicJson:async(_path,value)=>new Promise(resolve=>releases.push(()=>resolve(value)))});
  const first=save({wait:true});while(releases.length<1)await new Promise(resolve=>setTimeout(resolve,1));
  checkpoint={step:2};const second=save({wait:true});let firstDone=false,secondDone=false;first.then(()=>{firstDone=true;});second.then(()=>{secondDone=true;});
  releases.shift()();await first;assert.equal(firstDone,true);assert.equal(secondDone,false);
  while(releases.length<1)await new Promise(resolve=>setTimeout(resolve,1));releases.shift()();await second;assert.equal(secondDone,true);
});
const { validateResult, corroborates } = require('../lib/policy.cjs');
const { parseContent, reviewImage } = require('../lib/openrouter.cjs');
const { positions, makeImageAdapter } = require('../lib/images.cjs');
const primary = { id:'test/primary', name:'Primary', supported:[], pricing:{} }, secondary = { id:'test/secondary', name:'Secondary', supported:[], pricing:{} };
const no = { decision:'no', cue:'none', evidence:'No strict visible cue in this region.', location:'', confidence:.7, box:null, cost:.01, model:primary.id };
const hit = { decision:'hit', cue:'synagogue_ark_bimah', evidence:'An identifiable Torah ark is visible at the center of the room.', location:'Center frame', confidence:.9, box:[.2,.2,.3,.3], cost:.01, model:primary.id };
async function fixture(t, specs={ '1':['a','b'], '2':['c'] }, ledger) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [id,cards] of Object.entries(specs)){const dir=path.join(root,'frames',id,'cards');await fs.mkdir(dir,{recursive:true});for(let i=0;i<cards.length;i++)await fs.writeFile(path.join(dir,`card_${String(i+1).padStart(3,'0')}.jpg`),cards[i]);}
  if(ledger!==undefined)await S.atomicJson(path.join(root,'chat_verdicts.json'),ledger);
  return root;
}
const prepareCard = async p => [{ data:(await fs.readFile(p)).toString('base64'),mime:'image/png',bounds:{x:0,y:0,width:100,height:100},imageSize:{width:100,height:100} }];
const options = root => ({ root,key:'TEST_ONLY',primary,budget:100 });
test('review publishes starting state before workspace discovery yields',async t=>{
  const root=await fixture(t,{'1':['a']});
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>no});
  const run=e.run(options(root));
  assert.equal(e.running,true);
  assert.equal(e.state.status,'starting');
  assert.match(e.state.message,/restoring saved review progress/i);
  await run;
  assert.equal(e.state.status,'complete');
});
test('first strict hit stops that video; no requires every card',async t=>{
  const root=await fixture(t);let calls=0;const terminalBusy=[];const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=> ++calls===1?hit:no});e.on('state',s=>{if(s.status==='complete')terminalBusy.push(s.busy);});await e.run(options(root));
  const {entries}=await S.loadLedger(root);assert.equal(calls,2);assert.equal(entries[0].verdict,'jewish');assert.deepEqual(entries[0].cards_reviewed,['card_001.jpg']);assert.equal(entries[1].verdict,'no');assert.equal(e.state.status,'complete');
  assert.deepEqual(terminalBusy.slice(-2),[true,false]);assert.equal(e.snapshot().busy,false);
});
test('both independent models inspect every region before no',async t=>{
  const root=await fixture(t,{'1':['a','b','c']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;return no;}});await e.run({...options(root),secondary});
  assert.equal(calls,6);assert.equal((await S.loadLedger(root)).entries[0].cards_reviewed_count,3);
});
test('independent same evidence gives a hit and stops',async t=>{
  const root=await fixture(t,{'1':['a','b']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async({model})=>{calls++;return {...hit,model:model.id};}});await e.run({...options(root),secondary});
  assert.equal(calls,2);assert.equal((await S.loadLedger(root)).entries[0].verdict,'jewish');
});
test('unconfirmed positive is logged; remaining cards still inspected',async t=>{
  const root=await fixture(t,{'1':['a','b']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=> ++calls===1?hit:no});await e.run({...options(root),secondary});
  assert.equal(calls,4);const v=(await S.loadLedger(root)).entries[0];assert.equal(v.verdict,'no');assert.equal(v.uncorroborated_regions,1);
});
test('failed verifier does not save no; resume reuses successful primary image result',async t=>{
  const root=await fixture(t,{'1':['a']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;if(calls===2)throw new Error('Network failure');return no;}});
  await e.run({...options(root),secondary});assert.equal(e.state.status,'error');assert.equal((await S.loadLedger(root)).entries.length,0);
  await e.run({...options(root),secondary});assert.equal(calls,3);assert.equal(e.state.status,'complete');assert.equal((await S.loadLedger(root)).entries[0].verdict,'no');
});
test('pause checkpoints at image boundary and resume finishes coverage',async t=>{
  const root=await fixture(t,{'1':['a','b']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{if(++calls===1)e.pause();return no;}});
  await e.run(options(root));assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(root)).entries.length,0);await e.run(options(root));assert.equal(calls,2);assert.equal((await S.loadLedger(root)).entries.length,1);
});
test('exact duplicate cards reuse an existing verdict without a model call',async t=>{
  const root=await fixture(t,{'1':['same'],'2':['same']},[{id:'1',verdict:'jewish',summary:'Existing human verdict',cues:['judaica']}]);
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{throw new Error('Should not be called');}});await e.run(options(root));
  const v=(await S.loadLedger(root)).entries[1];assert.equal(v.copied_from,'1');assert.equal(v.verdict,'jewish');assert.deepEqual(v.cards_reviewed,[]);
});
test('matching titles alone never deduplicate',async t=>{
  const root=await fixture(t,{'1':['a'],'2':['different']});await S.atomicJson(path.join(root,'reelsight_manifest.json'),[{id:'1',title:'Same title'},{id:'2',title:'Same title'}]);let calls=0;
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;return no;}});await e.run(options(root));assert.equal(calls,2);
});

test('review progress retains completed IDs after no-hit media cleanup without double counting retained IDs',async t=>{
  const root=await fixture(t,{'retained':['already judged'],'next':['new pixels']},[
    {id:'cleaned',verdict:'no',cards_reviewed:['card_001.jpg']},
    {id:'retained',verdict:'jewish',cards_reviewed:['card_001.jpg']}
  ]);
  let calls=0;const states=[];
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;return no;}});
  e.on('state',state=>{if(state.status==='running')states.push({done:state.done,total:state.total});});
  await e.run(options(root));
  assert.equal(calls,1);assert.deepEqual(states[0],{done:2,total:3});
  assert.ok(states.every(s=>s.total===3&&s.done>=2&&s.done<=3));
  assert.equal(e.state.done,3);assert.equal(e.state.total,3);assert.equal(e.state.status,'complete');
});
test('missing image is an error, not no',async t=>{
  const root=await fixture(t,{'1':['bad']});const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:async()=>{throw new Error('Cannot decode image');},reviewer:async()=>no});await e.run(options(root));assert.equal(e.state.status,'error');assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('source changes while reviewing prevent saving any verdict',async t=>{
  const root=await fixture(t,{'1':['original']});await fs.writeFile(path.join(root,'reel.mp4'),'video');await S.atomicJson(path.join(root,'reelsight_manifest.json'),[{id:'1',mp4:'reel.mp4'}]);
  const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{await fs.writeFile(path.join(root,'frames','1','cards','card_001.jpg'),'changed');return no;}});await e.run(options(root));assert.equal(e.state.status,'error');assert.match(e.state.message,/changed/);assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('change of selected models invalidates partial checkpoint',async t=>{
  const root=await fixture(t,{'1':['a','b']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;if(calls===2)throw new Error('fail');return no;}});await e.run(options(root));await e.run({...options(root),primary:{...primary,id:'test/new-model'}});assert.equal(calls,4);
});
test('existing wrapped ledger shape and unknown fields are preserved, original is backed up',async t=>{
  const original={note:'keep me',verdicts:[{id:'old',verdict:'no',custom:42}]};const root=await fixture(t,{'1':['a']},original);
  await S.appendVerdict(root,{id:'1',verdict:'no'});const stored=await S.readJson(path.join(root,'chat_verdicts.json'));assert.equal(stored.note,'keep me');assert.equal(stored.verdicts[0].custom,42);assert.deepEqual(await S.readJson(path.join(root,'logs','chat_verdicts.before-reelsight.json')),original);
});
test('ID map supported and repeat append does not overwrite',async t=>{
  const root=await fixture(t,{'1':['a']},{1:{verdict:'no',summary:'keep'}});await S.appendVerdict(root,{id:'1',verdict:'jewish'});assert.equal((await S.loadLedger(root)).entries[0].summary,'keep');
});
test('unknown ledger format fails without changing original',async t=>{
  const root=await fixture(t,{'1':['a']},{unexpected:true});await assert.rejects(()=>S.loadLedger(root),/Unrecognized/);assert.deepEqual(await S.readJson(path.join(root,'chat_verdicts.json')),{unexpected:true});
});
test('budget pauses before next request without finalizing incomplete ID',async t=>{
  const root=await fixture(t,{'1':['a','b']});let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>{calls++;return{...no,cost:1};}});await e.run({...options(root),budget:.5});assert.equal(calls,1);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('project locking blocks concurrent writers',async t=>{
  const root=await fixture(t);const release=await S.acquireLock(root);try{await assert.rejects(()=>S.acquireLock(root),/already/);}finally{await release();}
});
test('strict parser rejects invented cue, malformed output, contradictory no and invalid confidence',()=>{
  assert.throws(()=>validateResult({...hit,cue:'jewish_surname'}));assert.throws(()=>parseContent('probably no'));assert.throws(()=>validateResult({...no,cue:'judaica'}));assert.throws(()=>validateResult({...hit,confidence:1.3}));assert.deepEqual(parseContent('```json\n'+JSON.stringify(wire(no))+'\n```').decision,'no');
});
test('different image locations cannot corroborate each other',()=>{assert.equal(corroborates(hit,{...hit,box:[.8,.8,.1,.1]}),false);assert.equal(corroborates(hit,hit),true);});

test('same MP4 with different story boundaries cannot copy a positive verdict',async t=>{
 const root=await fixture(t,{'1':['first'],'2':['second'],'3':['first']});
 await fs.writeFile(path.join(root,'reel.mp4'),'SAME SOURCE VIDEO');
 await S.atomicJson(path.join(root,'reelsight_manifest.json'),[
  {id:'1',mp4:'reel.mp4',scope:'segment',segment_start:275,segment_end:343},
  {id:'2',mp4:'reel.mp4',scope:'segment',segment_start:497,segment_end:551},
  {id:'3',mp4:'reel.mp4',scope:'segment',segment_start:275,segment_end:343}
 ]);
 let calls=0;const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard,reviewer:async()=>++calls===1?hit:no});await e.run(options(root));
 const v=(await S.loadLedger(root)).entries;assert.equal(calls,2);assert.equal(v[0].verdict,'jewish');assert.equal(v[1].verdict,'no');assert.equal(v[2].copied_from,'1');assert.notEqual(v[0].source_fingerprint,v[1].source_fingerprint);
});

test('pixel and 0-1000 boxes remain invalid; normalized evidence boxes pass',()=>{
  for (const box of [[108,10,658,418],[108,10,550,408],[.9,.2,.3,.3],[0,0,0,.5]]) {
    assert.throws(()=>parseContent(JSON.stringify({...wire(hit),box})),{code:'INVALID_VISUAL_RESULT'});
  }
  const box=[108/1280,10/1280,550/1280,408/1280];
  assert.deepEqual(parseContent(JSON.stringify({...wire(hit),box})).box,box);
});
test('region partition covers every pixel including far edge and tiny images',()=>{for(const size of [1,1280,1281,2000,5000,10000]){const xs=positions(size,1280,160);assert.equal(xs[0],0);assert.ok(xs.at(-1)+1280>=size);for(let i=1;i<xs.length;i++)assert.ok(xs[i]<=xs[i-1]+1280);}});
test('review tiles are JPEG quality 92 and stay under the 7 MB cap',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-jpeg-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'card.jpg');await fs.writeFile(file,'PIXELS');let quality;
 const prepareCard=makeImageAdapter({createFromBuffer:()=>({isEmpty:()=>false,getSize:()=>({width:20,height:20}),crop:()=>({toJPEG:q=>{quality=q;return Buffer.from('JPEGDATA');},toPNG:()=>{throw new Error('PNG tiles are no longer used');}})})});
 const regions=await prepareCard(file,true);assert.equal(quality,92);assert.equal(regions.length,1);assert.equal(regions[0].mime,'image/jpeg');assert.ok(Buffer.from(regions[0].data,'base64').length<7_000_000);
});
test('API adapter refuses missing pixels without a network request',async()=>{await assert.rejects(()=>reviewImage({key:'test',model:primary,image:null}),/Missing image pixels/);});
