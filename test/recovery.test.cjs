const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const S = require('../lib/storage.cjs'), R = require('../lib/recovery.cjs');
const { ReviewEngine } = require('../lib/engine.cjs');
const { PreparationPipeline, treeBytes } = require('../lib/pipeline.cjs');
const model = { id: 'test/local', name: 'Simulated provider', pricing: {} };
const no = { decision: 'no', cue: 'none', evidence: 'No strict visible cue.', location: '', confidence: .8, box: null, cost: .01 };
const prepareCard = async p => [{ data: (await fs.readFile(p)).toString('base64'), mime: 'image/png', bounds: { x: 0, y: 0, width: 100, height: 100 } }];
const error = (code, p) => Object.assign(new Error(`Injected ${code}`), { code, path: p });
async function fixture(t, ids = ['fho-216','fho-217']) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'reelsight-recovery-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const id of ids) { const folder = path.join(root,'frames',id,'cards'); await fs.mkdir(folder,{recursive:true}); await fs.writeFile(path.join(folder,'card_000001.jpg'),id); }
  return root;
}
async function managed(root,id) {
  const token = 'fixture-owner';
  const mp4 = path.join(root,'.pipeline','media',id,'source.mp4'); await fs.mkdir(path.dirname(mp4),{recursive:true}); await fs.writeFile(mp4,`source ${id}`);
  const card = path.join(root,'frames',id,'cards','card_000001.jpg');
  const receipt = { id, token, scope: 'segment', segment_start: 10, segment_end: 20, mp4: path.relative(root,mp4), cards: [{name:'card_000001.jpg'}], card_count:1, card_signature:await S.fingerprintCards({cards:[card]}), source_fingerprint:S.mediaFingerprint(await S.hashFile(mp4),{scope:'segment',segment_start:10,segment_end:20}) };
  await S.atomicJson(path.join(root,'.pipeline','owner.json'),{token});
  await S.atomicJson(path.join(root,'frames',id,'.reelsight-owned.json'),{token,relative:`frames/${id}`});
  await S.atomicJson(path.join(root,'.pipeline','receipts',`${id}.json`),receipt);
  await S.atomicJson(path.join(root,'frames',id,'prepared.json'),receipt);
  return receipt;
}
function engine(extra={}) { return new ReviewEngine({ prepareCard, reviewer:async()=>no, rateLimitOptions:{spacingMs:0}, recoveryOptions:{baseMs:5,maxMs:20,pollMs:2}, ...extra }); }
const run = (e,root) => e.run({root,key:'SIMULATION_ONLY',primary:model,budget:100});
function fastRetries(t) { const retry=R.retryIO; t.mock.method(R,'retryIO',(fn,opts)=>retry(fn,{...opts,sleep:async()=>{}})); }

test('Windows locks retry with bounded backoff; permanent IO failures preserve their code',async()=>{
  let calls=0;const delays=[];
  assert.equal(await R.retryIO(async()=>{if(++calls<4)throw error('EPERM');return'OK';},{sleep:async ms=>delays.push(ms)}),'OK');
  assert.deepEqual(delays,[50,100,200]);
  calls=0;await assert.rejects(()=>R.retryIO(async()=>{calls++;throw error('EIO');}),{code:'EIO'});assert.equal(calls,1);
  calls=0;await assert.rejects(()=>R.retryIO(async()=>{calls++;throw error('EBUSY');},{sleep:async()=>{}}),{code:'EBUSY'});assert.equal(calls,7);
});
test('completed fho-216 is never reopened while its files are cleaned; next ID proceeds',async t=>{
  const root=await fixture(t); await S.atomicJson(path.join(root,'chat_verdicts.json'),[{id:'fho-216',verdict:'no',source_fingerprint:'saved-pixels'}]);
  const read=fs.readFile;let forbidden=0,calls=0;
  t.mock.method(fs,'readFile',async(p,...args)=>{if(String(p).includes(path.join('frames','fho-216'))){forbidden++;throw error('EPERM',p);}return read(p,...args);});
  const e=engine({reviewer:async()=>{calls++;return no;}});await run(e,root);
  assert.equal(e.state.status,'complete');assert.equal(forbidden,0);assert.equal(calls,1);assert.equal((await S.loadLedger(root)).entries.length,2);
});
test('readJson retains EPERM code, original cause and path; exists never hides denied access',async t=>{
  fastRetries(t);const root=await fixture(t,[]),target=path.join(root,'protected.json');
  const read=fs.readFile,access=fs.access;
  t.mock.method(fs,'readFile',(p,...args)=>p===target?Promise.reject(error('EPERM',p)):read(p,...args));
  t.mock.method(fs,'access',(p,...args)=>p===target?Promise.reject(error('EACCES',p)):access(p,...args));
  await assert.rejects(()=>S.readJson(target,[]),e=>e.code==='EPERM'&&e.path===target&&e.cause.code==='EPERM');
  await assert.rejects(()=>S.exists(target),{code:'EACCES'});
});
test('locked prepared.json uses matching durable receipt, retaining exact story boundaries',async t=>{
  fastRetries(t);const root=await fixture(t,['fho-216']);await managed(root,'fho-216');const read=fs.readFile;
  t.mock.method(fs,'readFile',(p,...args)=>p===path.join(root,'frames','fho-216','prepared.json')?Promise.reject(error('EPERM',p)):read(p,...args));
  const p=await S.discover(root);assert.equal(p.issues.length,0);assert.equal(p.videos.length,1);assert.equal(p.videos[0].segment_start,10);assert.equal(p.recoveries[0].event,'prepared-receipt-fallback');
  assert.equal(await S.fingerprintVideo(p.videos[0]),p.videos[0].expectedFingerprint);
});
test('missing metadata never falls back to guessed source scope; bad coverage or ownership stays pending',async t=>{
  const root=await fixture(t,['fho-216']);const receipt=await managed(root,'fho-216');
  await fs.unlink(path.join(root,'frames','fho-216','prepared.json'));
  assert.equal((await S.discover(root)).videos.length,1);
  await S.atomicJson(path.join(root,'.pipeline','receipts','fho-216.json'),{...receipt,token:'wrong'});
  assert.equal((await S.discover(root)).issues.length,1);
  await S.atomicJson(path.join(root,'.pipeline','receipts','fho-216.json'),receipt);
  await fs.unlink(path.join(root,'frames','fho-216','cards','card_000001.jpg'));
  const p=await S.discover(root);assert.equal(p.videos.length,0);assert.match(p.issues[0].message,/coverage/);
});
test('receipt recovery refuses source pixels inconsistent with the preparation receipt',async t=>{
  const root=await fixture(t,['fho-216']);const receipt=await managed(root,'fho-216');await fs.writeFile(path.resolve(root,receipt.mp4),'different video');
  const p=await S.discover(root);await assert.rejects(()=>S.fingerprintVideo(p.videos[0]),e=>e.inputUnavailable&&e.manual&&e.recoveryKind==='source_changed'&&/differs/.test(e.message));
});
test('verified cards retain source identity after source cleanup and reject changed cards',async t=>{
  const root=await fixture(t,['fho-216']);const receipt=await managed(root,'fho-216');await fs.unlink(path.resolve(root,receipt.mp4));
  await S.atomicJson(path.join(root,'frames','fho-216','prepared.json'),{...receipt,source_retired:true});
  const p=await S.discover(root);assert.equal(await S.fingerprintVideo(p.videos[0]),receipt.source_fingerprint);
  await fs.appendFile(p.videos[0].cards[0],'changed');
  await assert.rejects(()=>S.fingerprintVideo(p.videos[0]),e=>e.inputUnavailable&&e.manual&&e.recoveryKind==='source_changed'&&/cards differ/.test(e.message));
});
test('review completes from verified cards after intentional source retirement',async t=>{
  const root=await fixture(t,['fho-216']);const receipt=await managed(root,'fho-216'),retired={...receipt,source_retired:true};
  await S.atomicJson(path.join(root,'frames','fho-216','prepared.json'),retired);await S.atomicJson(path.join(root,'.pipeline','receipts','fho-216.json'),retired);await fs.unlink(path.resolve(root,receipt.mp4));
  const e=engine();await run(e,root);assert.equal(e.state.status,'complete');assert.equal((await S.loadLedger(root)).entries[0].source_fingerprint,receipt.source_fingerprint);
});
test('receipt without explicit source retirement cannot stand in for a deleted source',async t=>{
  const root=await fixture(t,['fho-216']);const receipt=await managed(root,'fho-216');
  await fs.unlink(path.resolve(root,receipt.mp4));
  const p=await S.discover(root);await assert.rejects(()=>S.fingerprintVideo(p.videos[0]),e=>e.inputUnavailable&&/without a verified retirement receipt/.test(e.message));
});
test('one locked card defers its video, finishes another, then resumes without repeating a saved region',async t=>{
  const root=await fixture(t,['1','2']);await fs.writeFile(path.join(root,'frames','1','cards','card_000002.jpg'),'last');
  let failed=false,calls=0;const order=[];
  const e=engine({prepareCard:async p=>{if(p.endsWith('card_000002.jpg')&&!failed){failed=true;throw error('EPERM',p);}return prepareCard(p);},reviewer:async()=>{calls++;return no;}});
  e.on('verdict',v=>order.push(v.id));await run(e,root);
  assert.equal(e.state.status,'complete');assert.deepEqual(order,['2','1']);assert.equal(calls,3);assert.equal(e.state.deferred.length,0);
  const log=await fs.readFile(path.join(root,'logs','reelsight_recovery.jsonl'),'utf8');assert.match(log,/video-deferred/);assert.match(log,/video-recovered/);
  assert.deepEqual((await S.readJson(path.join(root,'logs','reelsight_deferred.json'))).videos,[]);
});
test('discovery isolates a permanently locked descriptor, records it and remains pausable',async t=>{
  fastRetries(t);const root=await fixture(t,['1','2']);const read=fs.readFile;
  t.mock.method(fs,'readFile',(p,...args)=>p===path.join(root,'frames','1','prepared.json')?Promise.reject(error('EPERM',p)):read(p,...args));
  let calls=0;const e=engine({reviewer:async()=>{calls++;return no;}});
  e.on('verdict',()=>e.pause());await run(e,root);
  assert.equal(e.state.status,'paused');assert.equal(calls,1);const entries=(await S.loadLedger(root)).entries;assert.deepEqual(entries.map(v=>v.id),['2']);
  assert.equal((await S.readJson(path.join(root,'logs','reelsight_deferred.json'))).videos[0].id,'1');
  assert.equal(e.state.total,2);assert.equal(e.state.done,1);
});
test('a deferred source remains pending across restart and is retried when it becomes readable',async t=>{
  const root=await fixture(t,['1']);const first=engine({prepareCard:async p=>{throw error('ENOENT',p);}});
  first.on('state',s=>{if(s.deferred?.length&&!first.pauseRequested)first.pause();});await run(first,root);assert.equal(first.state.status,'paused');
  const second=engine();await run(second,root);assert.equal(second.state.status,'complete');assert.equal((await S.loadLedger(root)).entries.length,1);assert.equal(second.state.deferred.length,0);
});
test('a checkpoint write failure stops paid work and never gets mistaken for a bad input file',async t=>{
  const root=await fixture(t,['1','2']),atomic=S.atomicJson;let calls=0;
  t.mock.method(S,'atomicJson',(p,...args)=>p.endsWith('reelsight_checkpoint.json')?Promise.reject(error('EPERM',p)):atomic(p,...args));
  const e=engine({reviewer:async()=>{calls++;return no;}});await run(e,root);
  assert.equal(e.state.status,'error');assert.equal(calls,1);assert.equal((await S.loadLedger(root)).entries.length,0);assert.equal(e.state.deferred.length,0);
});
test('disk scan recovers a temporary lock without undercounting retained data',async()=>{
  let attempts=0;const file={name:'prepared.json',isSymbolicLink:()=>false,isDirectory:()=>false,isFile:()=>true};
  assert.equal(await treeBytes('fixture',{readdir:async()=>[file],lstat:async()=>{if(!attempts++)throw error('EPERM');return{size:42,isSymbolicLink:()=>false,isFile:()=>true};}}),42);
});
test('deferred ready videos do not satisfy the backfill reserve',()=>{
  const p=new PreparationPipeline({tools:{}});p.store={readyReels:()=>[{id:'1',source_hash:'a',card_count:4,frame_count:60},{id:'2',source_hash:'b',card_count:5,frame_count:80}]};
  p.deferredIds=new Set(['1']);const b=p.backlog();assert.equal(b.ahead_reels,1);assert.equal(b.ahead_cards,5);
});
