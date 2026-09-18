const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PreparationPipeline,ownedRemove}=require('../lib/pipeline.cjs');
const {parseDelimited,sourceRows,stableId}=require('../lib/queue.cjs');
const {ReviewEngine}=require('../lib/engine.cjs');const S=require('../lib/storage.cjs');
const R=require('../lib/recovery.cjs');
async function fixture(t,urls=['https://example.org/a.mp4'],overrides={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-prep-'));
 let downloads=0,extracts=0;
 const media={resolveMedia:async url=>({url,direct:true}),download:async(r,folder)=>{downloads++;const file=path.join(folder,'source.mp4');await fs.writeFile(file,r.url);return file;},makeCards:async(_file,folder)=>{extracts++;await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS');return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};},...overrides};
 const p=new PreparationPipeline({tools:{},media});await p.open(root);p.usage=async()=>({bytes:100,free:100*1024**3});
 const file=path.join(root,'urls.txt');await fs.writeFile(file,urls.join('\n'));p.store.import(file);
 t.after(async()=>{await p.liveWrite;p.store.close();const target=await fs.realpath(root);assert.ok(target.startsWith(await fs.realpath(os.tmpdir())));await fs.rm(target,{recursive:true,force:true});});
 return{root,p,counts:()=>({downloads,extracts})};
}
async function noVerdict(root,id){const receipt=await S.readJson(path.join(root,'.pipeline','receipts',`${id}.json`));return{id,verdict:'no',cards_reviewed:receipt.cards.map(c=>c.name),cards_total:receipt.card_count,source_fingerprint:receipt.source_fingerprint,method:'test-completed-review'};}
test('cleanup resumes after a partial delete removed the ownership marker',async t=>{
 const{root,p}=await fixture(t);await p.run();const id=p.store.all('ready')[0].id,target=await fs.realpath(path.join(root,'frames',id)),remove=fs.rm;let interrupted=false;
 t.mock.method(fs,'rm',async(file,...args)=>{if(file===target&&!interrupted){interrupted=true;await remove(path.join(target,'.reelsight-owned.json'));throw Object.assign(new Error('Child file locked'),{code:'EPERM'});}return remove(file,...args);});
 await assert.rejects(()=>ownedRemove(root,`frames/${id}`,p.token),{code:'EPERM'});
 assert.equal(await S.exists(path.join(target,'.reelsight-owned.json')),false);
 await ownedRemove(root,`frames/${id}`,p.token);assert.equal(await S.exists(target),false);
});
test('staging can recover after a publication rename failed with the final ownership marker already written',async t=>{
 const{p}=await fixture(t),rename=fs.rename,retry=R.retryIO;let failures=0;
 t.mock.method(R,'retryIO',(fn,opts)=>retry(fn,{...opts,sleep:async()=>{}}));
 t.mock.method(fs,'rename',async(from,to)=>{if(String(from).includes(path.join('.pipeline','staging'))&&!String(from).endsWith('.tmp')&&failures++<7)throw Object.assign(new Error('Published folder locked'),{code:'EPERM'});return rename(from,to);});
 p.on('state',()=>{for(const id of p.preparationRetries.keys())p.preparationRetries.set(id,0);});
 await p.run();assert.equal(p.state.status,'complete');assert.equal(p.store.counts().ready,1);assert.equal(p.store.all('ready')[0].attempts,2);
});
test('an exactly empty staging folder left before its owner marker is safely recovered',async t=>{
 const{root,p}=await fixture(t);const id=p.store.all('pending')[0].id;
 await fs.mkdir(path.join(root,'.pipeline','staging',id),{recursive:true});
 await p.run();assert.equal(p.store.get(id).status,'ready');assert.equal(await S.exists(path.join(root,'frames',id,'cards','card_000001.jpg')),true);
 const events=await fs.readFile(path.join(root,'logs','prepare_events.jsonl'),'utf8');assert.match(events,/recovered-empty-unowned-staging/);
});
test('a locked cleanup receipt preserves that video and still cleans another completed no',async t=>{
 const{root,p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4']);await p.run();
 const rows=p.store.all('ready');for(const row of rows)await S.appendVerdict(root,await noVerdict(root,row.id));
 const read=S.readJson;t.mock.method(S,'readJson',(file,...args)=>file===path.join(root,'.pipeline','receipts',`${rows[0].id}.json`)?Promise.reject(Object.assign(new Error('Locked receipt'),{code:'EPERM'})):read(file,...args));
 await p.syncVerdicts();assert.equal(p.store.get(rows[1].id).status,'cleaned');assert.equal(p.store.get(rows[0].id).status,'ready');assert.match(p.store.get(rows[0].id).error,/automatic retry/);
 assert.equal((await S.loadLedger(root)).entries.length,2);assert.ok(p.cleanupRetries.has(rows[0].id));
 t.mock.restoreAll();p.cleanupRetries.set(rows[0].id,{attempts:1,next:0});await p.syncVerdicts();assert.equal(p.store.get(rows[0].id).status,'cleaned');
});
test('temporary preparation file error allows another source ahead and then retries automatically',async t=>{
 const{p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4']);const make=p.media.makeCards;let locked=true;const ready=[];
 p.media.makeCards=async(...args)=>{if(locked){locked=false;throw Object.assign(new Error('Locked image output'),{code:'EPERM'});}return make(...args);};
 p.on('ready',v=>{ready.push(v.id);for(const id of p.preparationRetries.keys())p.preparationRetries.set(id,0);});
 await p.run();assert.equal(p.state.status,'complete');assert.equal(p.store.counts().ready,2);assert.equal(ready.length,2);assert.equal(p.store.counts().error||0,0);
});
test('a transient source outage is retried automatically instead of becoming a permanent queue error',async t=>{
 let unavailable=true;const transient=Object.assign(new Error('fetch failed'),{sourceTransient:true});
 const{p}=await fixture(t,undefined,{resolveMedia:async url=>{if(unavailable){unavailable=false;throw transient;}return{url,direct:true};}});
 p.on('state',()=>{for(const id of p.preparationRetries.keys())p.preparationRetries.set(id,0);});
 await p.run();assert.equal(p.store.counts().ready,1);assert.equal(p.store.counts().error||0,0);assert.equal(p.store.all('ready')[0].attempts,2);
});
test('URL lists parse quoted text and first headerless TSV record, ignore textual verdicts',async t=>{
 assert.deepEqual(parseDelimited('url,title\n"https://a.test/x","One, two\nthree"'),[['url','title'],['https://a.test/x','One, two\nthree']]);
 const{root}=await fixture(t);const p=path.join(root,'a.tsv');await fs.writeFile(p,'172014\tA title\thttps://filmhiradokonline.hu/watch.php?id=3224\n2\tB\thttps://a.test/b');assert.equal(sourceRows(p).length,2);assert.equal(stableId(sourceRows(p)[0].url),'fho-3224');
});
test('producer publishes complete cards without writing a classification',async t=>{
 const{root,p}=await fixture(t);await p.run();const row=p.store.all('ready')[0],video=(await S.discover(root)).videos[0];assert.equal(p.store.counts().ready,1);assert.equal(video.cards.length,1);assert.equal(await S.exists(path.join(root,'chat_verdicts.json')),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',row.id)),false);assert.equal(video.prepared.source_retired,true);assert.equal(typeof video.prepared.card_signature,'string');
});
test('failed extraction publishes nothing, keeps source and supports retry',async t=>{
 const{root,p}=await fixture(t,undefined,{makeCards:async()=>{throw new Error('Truncated video');}});await p.run();assert.equal(p.store.counts().error,1);assert.equal((await S.discover(root)).videos.length,0);assert.equal((await S.loadLedger(root)).entries.length,0);assert.equal(await S.exists(path.join(root,'.pipeline','media',stableId('https://example.org/a.mp4'),'source.mp4')),true);
});
test('records without a public preview are separated from actionable source errors',async t=>{
 const unavailable=Object.assign(new Error('PREVIEW_UNAVAILABLE: Request Preview on the source page.'),{code:'PREVIEW_UNAVAILABLE'});
 const{p}=await fixture(t,undefined,{resolveMedia:async()=>{throw unavailable;}});await p.run();assert.equal(p.store.counts().unavailable,1);assert.equal(p.store.counts().error||0,0);
});
test('storage pressure evicts disposable downloads without deleting hit or manual-review cards',async t=>{
 const{root,p}=await fixture(t,['https://example.org/pending.mp4','https://example.org/error.mp4','https://example.org/hit.mp4','https://example.org/manual.mp4']);
 const rows=p.store.all('pending');
 for(const row of rows){const media=await p.markFolder(`.pipeline/media/${row.id}`);await fs.writeFile(path.join(media,'source.mp4'),'DISPOSABLE SOURCE');p.store.update(row.id,{owner_id:row.id,bytes:18});}
 p.store.update(rows[1].id,{status:'error',error:'download failed'});p.store.update(rows[2].id,{status:'hit'});p.store.update(rows[3].id,{status:'ready'});
 for(const row of [rows[2],rows[3]]){const cards=await p.markFolder(`frames/${row.id}`);await fs.mkdir(path.join(cards,'cards'));await fs.writeFile(path.join(cards,'cards','card_000001.jpg'),'KEEP REVIEW PIXELS');}
 p.setDeferredItems([{id:rows[3].id,manual:true}]);await p.syncVerdicts();
 const reclaimed=await p._reclaimStoragePressure();
 assert.ok(reclaimed>0);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',rows[0].id)),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',rows[1].id)),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',rows[2].id)),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',rows[3].id)),false);
 assert.equal(await S.exists(path.join(root,'frames',rows[2].id,'cards','card_000001.jpg')),true);
 assert.equal(await S.exists(path.join(root,'frames',rows[3].id,'cards','card_000001.jpg')),true);
 assert.equal(p.store.get(rows[0].id).status,'pending');assert.equal(p.store.get(rows[1].id).status,'error');
});
test('working storage excludes confirmed-hit and manual-review evidence without hiding total cards',async t=>{
 const{root,p}=await fixture(t,['https://example.org/hit.mp4','https://example.org/manual.mp4','https://example.org/working.mp4']);
 const rows=p.store.all('pending');
 for(const [index,row] of rows.entries()){
  const folder=await p.markFolder(`frames/${row.id}`);await fs.mkdir(path.join(folder,'cards'));
  await fs.writeFile(path.join(folder,'cards','card_000001.jpg'),'X'.repeat(100+index));
 }
 p.hitIds=new Set([rows[0].id]);p.manualDeferredIds=new Set([rows[1].id]);
 const usage=await PreparationPipeline.prototype.usage.call(p);
 assert.equal(usage.bytes,usage.footageBytes+usage.cardBytes);
 assert.equal(usage.guardBytes,usage.footageBytes+usage.workingCardBytes);
 assert.equal(usage.cardBytes,usage.retainedCardBytes+usage.workingCardBytes);
 assert.ok(usage.retainedCardBytes>0);assert.ok(usage.workingCardBytes>0);
 assert.ok(usage.guardBytes<usage.bytes,'retained evidence does not deadlock the working limit');
});
test('a corrected FFmpeg odd-width geometry failure retries automatically on the next run',async t=>{
 const message='ffmpeg.exe failed: Padded dimensions cannot be smaller than input dimensions.';
 const{p}=await fixture(t,undefined,{makeCards:async()=>{throw new Error(message);}});
 await p.run();assert.equal(p.store.counts().error,1);
 p.media.makeCards=async(_file,folder)=>{await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS');return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};};
 await p.run();assert.equal(p.store.counts().ready,1);assert.equal(p.store.counts().error||0,0);
});
test('invalid story range deletes the leftover download and does not publish cards',async t=>{
 const{root,p}=await fixture(t,undefined,{makeCards:async()=>{throw new Error('Story time range is invalid or outside the downloaded reel. Nothing published.');}});
 await p.run();
 const id=stableId('https://example.org/a.mp4');
 assert.equal(p.store.counts().error,1);assert.equal(p.store.get(id).status,'error');
 assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','staging',id)),false);
 assert.equal((await S.discover(root)).videos.length,0);
 assert.ok(p.state.reclaimed>0);
});
test('existing invalid-range leftovers are reclaimed on the next verdict sync',async t=>{
 const{root,p}=await fixture(t);
 const id=stableId('https://example.org/a.mp4');
 p.store.update(id,{status:'error',error:'Story time range is invalid or outside the downloaded reel. Nothing published.',owner_id:id});
 const media=await p.markFolder(`.pipeline/media/${id}`);
 await fs.writeFile(path.join(media,'source.mp4'),'LEFTOVER DOWNLOAD');
 await p.syncVerdicts();
 assert.equal(p.store.get(id).status,'error');
 assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);
 assert.ok(p.state.reclaimed>0);
});
test('completed no reclaims owned footage and cards but retains URLs and receipts',async t=>{
 const{root,p}=await fixture(t);await p.run();const id=p.store.all('ready')[0].id;await S.appendVerdict(root,await noVerdict(root,id));await p.syncVerdicts();assert.equal(p.store.get(id).status,'cleaned');assert.equal(await S.exists(path.join(root,'frames',id)),false);assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);assert.equal(await S.exists(path.join(root,'.pipeline','receipts',`${id}.json`)),true);assert.equal((await S.loadLedger(root)).entries.length,1);
});

test('manual holds retain cards and durable receipts after published source cleanup',async t=>{
 const{root,p}=await fixture(t);await p.run();const id=p.store.all('ready')[0].id;
 assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);
 p.setDeferredItems([{id,manual:true,reason:'provider_refusal'}]);await p.syncVerdicts();
 assert.equal(p.store.get(id).status,'ready');
 assert.equal(p.store.get(id).bytes,0);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);
 assert.equal(await S.exists(path.join(root,'frames',id,'cards','card_000001.jpg')),true);
 assert.equal(await S.exists(path.join(root,'.pipeline','receipts',`${id}.json`)),true);
});

test('manual cleanup bypasses retry backoff and removes completed and disposable media',async t=>{
 const{root,p}=await fixture(t);await p.run();
 const completed=p.store.all('ready')[0];
 const more=path.join(root,'more.txt');await fs.writeFile(more,'https://example.org/pending.mp4');p.store.import(more);
 const pending=p.store.all('pending')[0],media=await p.markFolder(`.pipeline/media/${pending.id}`);await fs.writeFile(path.join(media,'source.mp4'),'PARTIAL');
 await S.appendVerdict(root,await noVerdict(root,completed.id));
 p.cleanupRetries.set(completed.id,{attempts:3,next:Date.now()+300000});
 const cleanup=p.cleanupNow();assert.equal(p.cleanupNow(),cleanup,'concurrent cleanup clicks share one ownership-safe pass');const result=await cleanup;
 assert.ok(result.reclaimed>0);assert.equal(p.store.get(completed.id).status,'cleaned');
 assert.equal(await S.exists(path.join(root,'.pipeline','media',completed.id)),false);
 assert.equal(await S.exists(path.join(root,'.pipeline','media',pending.id)),false);
 assert.equal(result.bytes,result.state.bytes);
});

test('real no-verdict cleanup during a disk scan preserves the ledger and allows more preparation',async t=>{
 const {root,p}=await fixture(t);await p.run();
 const id=p.store.all('ready')[0].id,folder=path.join(root,'frames',id);
 await S.appendVerdict(root,await noVerdict(root,id));
 const original=fs.readdir;let cleanedDuringScan=false;t.after(()=>{fs.readdir=original;});
 fs.readdir=async function(target,...args){
  const entries=await original.call(this,target,...args);
  if(target===folder&&!cleanedDuringScan){cleanedDuringScan=true;await p.syncVerdicts();}
  return entries;
 };
 const use=await PreparationPipeline.prototype.usage.call(p);
 assert.ok(cleanedDuringScan);assert.ok(Number.isFinite(use.bytes) && use.bytes >= 0);assert.equal(p.store.get(id).status,'cleaned');
 assert.equal((await S.loadLedger(root)).entries.length,1);assert.equal(await S.exists(path.join(root,'.pipeline','receipts',`${id}.json`)),true);
 fs.readdir=original;
 const extra=path.join(root,'more.txt');await fs.writeFile(extra,'https://example.org/next.mp4');p.store.import(extra);
 await p.run();assert.equal(p.state.status,'complete');assert.equal(p.store.counts().ready,1);assert.equal(p.store.counts().cleaned,1);
});
test('incomplete no and mismatching source hashes never trigger deletion',async t=>{
 const{root,p}=await fixture(t);await p.run();const id=p.store.all('ready')[0].id;const verdict=await noVerdict(root,id);verdict.cards_reviewed=[];await S.atomicJson(path.join(root,'chat_verdicts.json'),[verdict]);await p.syncVerdicts();assert.equal(p.store.get(id).status,'ready');verdict.cards_reviewed=['card_000001.jpg'];verdict.source_fingerprint='wrong';await S.atomicJson(path.join(root,'chat_verdicts.json'),[verdict]);await p.syncVerdicts();assert.equal(await S.exists(path.join(root,'frames',id)),true);
});
test('hits retain only evidence cards and receipts while deleting the downloaded source video',async t=>{
 const makeCards=async(_file,folder)=>{await fs.mkdir(folder,{recursive:true});for(let i=1;i<=3;i++)await fs.writeFile(path.join(folder,`card_${String(i).padStart(6,'0')}.jpg`),`PIXELS ${i}`);return{duration:9,fps:1,frame_count:9,card_count:3,cards:[1,2,3].map(i=>({name:`card_${String(i).padStart(6,'0')}.jpg`,frames:3}))};};
 const{root,p}=await fixture(t,undefined,{makeCards});await p.run();const id=p.store.all('ready')[0].id,base=await noVerdict(root,id);await S.appendVerdict(root,{...base,verdict:'jewish',evidence:{card:'card_000002.jpg'}});await p.syncVerdicts();assert.equal(p.store.get(id).status,'hit');assert.equal(await S.exists(path.join(root,'frames',id,'cards','card_000001.jpg')),false);assert.equal(await S.exists(path.join(root,'frames',id,'cards','card_000002.jpg')),true);assert.equal(await S.exists(path.join(root,'frames',id,'cards','card_000003.jpg')),false);assert.equal(await S.exists(path.join(root,'.pipeline','media',id)),false);assert.equal(await S.exists(path.join(root,'.pipeline','receipts',`${id}.json`)),true);assert.ok(p.state.reclaimed>0);
});
test('cleanup rejects escape paths and folders without matching ownership',async t=>{
 const{root,p}=await fixture(t);await assert.rejects(ownedRemove(root,'../outside',p.token),/outside/);await fs.mkdir(path.join(root,'frames','unowned'));await fs.writeFile(path.join(root,'frames','unowned','keep.txt'),'keep');await assert.rejects(ownedRemove(root,'frames/unowned',p.token),/ownership/);assert.equal(await fs.readFile(path.join(root,'frames','unowned','keep.txt'),'utf8'),'keep');
});
test('same resolved whole reel downloads once; alias verdict copies after owner cleanup',async t=>{
 const{root,p,counts}=await fixture(t,['https://example.org/a','https://example.org/b'],{resolveMedia:async()=>({url:'https://example.org/whole.mp4',direct:true})});await p.run({buffer:3});assert.equal(counts().downloads,1);assert.equal(counts().extracts,1);
 const owner=p.store.all('ready').find(r=>r.owner_id===r.id),alias=p.store.all('ready').find(r=>r.owner_id!==r.id);await S.appendVerdict(root,await noVerdict(root,owner.id));await p.syncVerdicts();assert.equal(p.store.get(owner.id).status,'cleaned');
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},reviewer:async()=>{throw new Error('No images should be rereviewed');},prepareCard:async()=>{throw new Error('No cards needed');}});await e.run({root,key:'test',primary:{id:'test/model',name:'Test'},budget:1,followPreparation:()=>false});assert.equal(e.state.status,'complete');const v=(await S.loadLedger(root)).entries.find(v=>v.id===alias.id);assert.equal(v.method,'shared-reel-copy');assert.equal(v.copied_from,owner.id);await p.syncVerdicts();assert.equal(p.store.get(alias.id).status,'cleaned');
});
test('buffer stops preparation without downloading the whole URL list',async t=>{
 const{p,counts}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4']);p.on('state',s=>{if(s.status==='buffered')p.pause();});await p.run({buffer:1});assert.equal(counts().downloads,1);assert.equal(p.store.counts().pending,1);assert.equal(p.state.status,'paused');
});

test('reserve counts distinct reels instead of shared video IDs',async t=>{
 const urls=['https://example.org/a1','https://example.org/a2','https://example.org/b1','https://example.org/c1'];
 const{p,counts}=await fixture(t,urls,{resolveMedia:async url=>({url:`https://example.org/${url.split('/').pop()[0]}.mp4`,direct:true})});
 p.on('state',s=>{if(s.status==='buffered')p.pause();});await p.run({buffer:2});
 assert.equal(counts().downloads,2);assert.equal(p.store.counts().ready,3);assert.equal(p.store.counts().pending,1);
 assert.equal(p.state.backlog.ahead_reels,2);assert.equal(p.state.backlog.ahead_cards,2);
});

test('taking a reel for review refills the reserve before a verdict or cleanup',async t=>{
 const{root,p,counts}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4','https://example.org/c.mp4']);let stage=0;
 p.on('state',s=>{
  if(s.status!=='buffered'||s.backlog.ahead_reels!==1)return;
  if(stage===0){stage=1;p.setReviewId(p.store.all('ready')[0].id);}
  else if(s.backlog.ready_reels===2){stage=2;p.pause();}
 });
 await p.run({buffer:1});assert.equal(stage,2);assert.equal(counts().downloads,2);
 assert.equal((await S.loadLedger(root)).entries.length,0);assert.equal(p.state.backlog.ahead_reels,1);assert.equal(p.state.backlog.ready_reels,2);
 assert.equal(p.store.counts().pending,1);
});

test('identical downloaded pixels from different URLs occupy one reserve slot',async t=>{
 const{p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4'],{download:async(_r,folder)=>{const file=path.join(folder,'source.mp4');await fs.writeFile(file,'IDENTICAL SOURCE');return file;}});
 await p.run({buffer:3});assert.equal(p.state.status,'complete');assert.equal(p.store.counts().ready,2);
 assert.equal(p.state.backlog.ahead_reels,1);assert.equal(p.state.backlog.ahead_frames,3);
});

test('reserve never counts completed hit or no assets as future image work',async t=>{
 const{root,p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4']);await p.run();
 const [a,b]=p.store.all('ready');await S.appendVerdict(root,{...await noVerdict(root,a.id),verdict:'jewish',evidence:{card:'card_000001.jpg'}});await S.appendVerdict(root,await noVerdict(root,b.id));
 await p.syncVerdicts();assert.equal(p.state.backlog.ahead_reels,0);assert.equal(p.state.backlog.ahead_cards,0);
 assert.equal(p.store.counts().hit,1);assert.equal(p.store.counts().cleaned,1);
});

test('cold review waits for new cards and reports producer failure without inventing a verdict',async t=>{
 const{root,p}=await fixture(t);const engine=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:async()=>{throw new Error('No cards should exist');},reviewer:async()=>{throw new Error('No inference expected');}});
 let waits=0;engine.on('state',s=>{if(s.message.includes('Waiting for the footage'))waits++;});
 const state=await engine.run({root,key:'test',primary:{id:'test/vision',name:'Test'},budget:1,followPreparation:()=>waits?{running:false,status:'error',message:'Storage cap reached'}:{running:true,status:'running'}});
 assert.ok(waits>=1);assert.equal(state.status,'error');assert.match(state.message,/Storage cap reached/);assert.equal((await S.loadLedger(root)).entries.length,0);
});
test('import is idempotent and does not discard source entries already marked done',async t=>{
 const{root,p}=await fixture(t);const r=p.store.import(path.join(root,'urls.txt'));assert.equal(r.added,0);assert.equal(r.alreadyPresent,1);assert.equal(p.store.counts().total,1);
});
test('producer and classifier run independently through multiple bounded-buffer handoffs',async t=>{
 const{root,p,counts}=await fixture(t,['https://example.org/one.mp4','https://example.org/two.mp4']);
 const preparing=p.run({buffer:1});let calls=0;
 const e=new ReviewEngine({rateLimitOptions:{spacingMs:0},prepareCard:async()=>[{data:'UElYRUxT',mime:'image/png',bounds:{x:0,y:0,width:1,height:1},imageSize:{width:1,height:1}}],reviewer:async()=>{calls++;return{decision:'no',cue:'none',evidence:'No qualifying visual evidence.',location:'',confidence:.8,box:null,cost:0};}});
 await e.run({root,key:'test',primary:{id:'test/model',name:'Test'},budget:1,followPreparation:()=>p.running});
 await preparing;await p.syncVerdicts();
 assert.equal(calls,2);assert.equal(counts().downloads,2);assert.equal(p.store.counts().cleaned,2);assert.equal((await S.loadLedger(root)).entries.length,2);assert.equal(e.state.status,'complete');
});
test('identical MP4 bytes from different URLs reuse no and both downloads can be cleared',async t=>{
 const{root,p}=await fixture(t,['https://example.org/one.mp4','https://example.org/two.mp4'],{download:async(_r,folder)=>{const file=path.join(folder,'source.mp4');await fs.writeFile(file,'IDENTICAL WHOLE REEL');return file;}});
 await p.run({buffer:3});const rows=p.store.all('ready');const first=await noVerdict(root,rows[0].id);await S.appendVerdict(root,first);
 await S.appendVerdict(root,{...first,id:rows[1].id,method:'shared-reel-copy',copied_from:rows[0].id,cards_reviewed:[]});await p.syncVerdicts();assert.equal(p.store.counts().cleaned,2);
});

test('different stories in one MP4 get separate cards and identities; only identical ranges alias',async t=>{
 const calls=[];
 const {root,p}=await fixture(t,['https://example.org/a','https://example.org/b','https://example.org/c'],{
  resolveMedia:async url=>({url:'https://example.org/reel.mp4',direct:true,scope:'segment',segment_start:url.endsWith('/b')?3:0,segment_end:url.endsWith('/b')?6:3}),
  download:async(_r,folder)=>{const file=path.join(folder,'source.mp4');if(!await S.exists(file)){calls.push('download');await fs.writeFile(file,'SAME REEL');}return file;},
  makeCards:async(_file,folder,_tools,opts)=>{calls.push([opts.segment_start,opts.segment_end]);await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS '+opts.segment_start);return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};}
 });
 await p.run({buffer:3});const [a,b,c]=p.store.all('ready');
 assert.equal(a.owner_id,a.id);assert.equal(b.owner_id,b.id);assert.equal(c.owner_id,a.id);assert.equal(p.backlog().ready_reels,2);
 assert.deepEqual(calls,['download',[0,3],'download',[3,6]]);
 const ra=await S.readJson(path.join(root,'.pipeline','receipts',a.id+'.json')),rb=await S.readJson(path.join(root,'.pipeline','receipts',b.id+'.json'));
 assert.notEqual(ra.source_fingerprint,rb.source_fingerprint);assert.equal(ra.scope,'segment');assert.equal(rb.segment_start,3);
});

test('distinct source downloads run concurrently instead of serializing preparation',async t=>{
 let activeDownloads=0,peakDownloads=0;
 const{p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4'],{
  download:async(r,folder)=>{activeDownloads++;peakDownloads=Math.max(peakDownloads,activeDownloads);try{await new Promise(resolve=>setTimeout(resolve,30));const file=path.join(folder,'source.mp4');await fs.writeFile(file,r.url);return file;}finally{activeDownloads--; }},
  makeCards:async(_file,folder)=>{await new Promise(r=>setTimeout(r,30));await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS');return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};}
 });
 p.getReviewLoad=()=>({workers:128,videoConcurrency:2});
 await p.run({buffer:3});assert.equal(p.state.status,'complete');assert.equal(p.store.counts().ready,2);assert.equal(peakDownloads,2);
});
test('high review concurrency prepares several independent videos at once',async t=>{
 let active=0,peak=0;
 const urls=Array.from({length:8},(_,i)=>`https://example.org/concurrent-${i}.mp4`),{p}=await fixture(t,urls,{
  makeCards:async(_file,folder)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,40));await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS');return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};}finally{active--;}}
 });
 p.getReviewLoad=()=>({workers:64,videoConcurrency:16});
 p.on('state',s=>{if(s.status==='buffered'&&p.store.counts().ready===8)p.pause();});
 await p.run({buffer:8});assert.ok(peak>1&&peak<=8,`peak preparation concurrency ${peak}`);assert.equal(p.store.counts().ready,8);
});
test('different segments of one source share its download while extracting concurrently',async t=>{
 let active=0,peak=0,downloads=0;
 let releaseOverlap;const overlapStarted=new Promise(resolve=>{releaseOverlap=resolve;});let waitForOverlap=true;
 const urls=Array.from({length:4},(_,i)=>`https://example.org/story-${i}`),{root,p}=await fixture(t,urls,{
  resolveMedia:async url=>{const i=Number(url.match(/(\d+)$/)[1]);return{url:'https://example.org/shared-reel.mp4',direct:true,scope:'segment',segment_start:i*10,segment_end:i*10+10};},
  download:async(_resolved,folder)=>{const file=path.join(folder,'source.mp4');if(!await S.exists(file)){downloads++;await fs.writeFile(file,'SHARED SOURCE');}return file;},
  makeCards:async(_file,folder,_tools,{segment_start})=>{active++;peak=Math.max(peak,active);try{if(waitForOverlap){waitForOverlap=false;await Promise.race([overlapStarted,new Promise(r=>setTimeout(r,2000))]);}else releaseOverlap();await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS '+segment_start);return{duration:10,fps:1,frame_count:10,card_count:1,cards:[{name:'card_000001.jpg',frames:10}]};}finally{active--;}}
 });
 p.getReviewLoad=()=>({workers:64,videoConcurrency:4});await p.run({buffer:8});
 assert.equal(downloads,1);assert.ok(peak>1&&peak<=4,`peak shared-source extraction ${peak}`);assert.equal(p.store.counts().ready,4);
 for(const row of p.store.all('ready'))assert.equal(await S.exists(path.join(root,'.pipeline','media',row.id)),false);
});
test('pause aborts an overlapped download and leaves unfinished rows pending',async t=>{
 const{p}=await fixture(t,['https://example.org/a.mp4','https://example.org/b.mp4'],{
  download:async(r,folder,tools,{signal})=>{
   const file=path.join(folder,'source.mp4');await fs.writeFile(file,r.url);
   if(p.extractingId)await new Promise((resolve,reject)=>{const t=setTimeout(resolve,200);signal.addEventListener('abort',()=>{clearTimeout(t);reject(new Error('Preparation paused. Partial work is saved.'));},{once:true});});
   return file;
  },
  makeCards:async(_file,folder)=>{p.pause();await fs.mkdir(folder,{recursive:true});await fs.writeFile(path.join(folder,'card_000001.jpg'),'PIXELS');return{duration:3,fps:1,frame_count:3,card_count:1,cards:[{name:'card_000001.jpg',frames:3}]};}
 });
 await p.run({buffer:3});assert.equal(p.state.status,'paused');
 assert.equal(p.store.all('downloading').length,0);assert.equal(p.store.all('extracting').length,0);assert.equal(p.store.all('resolving').length,0);
 assert.ok((p.store.counts().pending||0)+(p.store.counts().ready||0)===2);
});
test('backfill maintains its reserve beyond every active video and protects their cards until settled',async t=>{
 const {root,p,counts}=await fixture(t,['https://example.org/one.mp4','https://example.org/two.mp4','https://example.org/three.mp4','https://example.org/four.mp4']);let active=[];
 p.on('state',s=>{if(s.status!=='buffered')return;const ready=p.store.all('ready');if(ready.length<=2){active=ready.map(v=>v.id);p.setReviewIds(active);}else if(ready.length===3)p.pause();});
 await p.run({buffer:1});assert.equal(counts().downloads,3);assert.equal(p.backlog().ahead_reels,1);assert.equal(p.backlog().reviewing_ids.length,2);assert.equal(p.backlog().reviewing_reels,2);
 const id=active[0];await S.appendVerdict(root,await noVerdict(root,id));await p.syncVerdicts();assert.ok(await S.exists(path.join(root,'frames',id)));assert.equal(p.store.get(id).status,'ready');
 p.setReviewIds(active.slice(1));await p.syncVerdicts();assert.equal(p.store.get(id).status,'cleaned');assert.ok(await S.exists(path.join(root,'frames',active[1])));
});
test('a 64-worker review expands the reserve to 32 clips beyond 16 active videos',async t=>{
 const urls=Array.from({length:49},(_,i)=>`https://example.org/parallel-${i}.mp4`),{p,counts}=await fixture(t,urls);
 p.getReviewLoad=()=>({workers:64,videoConcurrency:16});let claimed=false;
 p.on('state',s=>{
  if(s.status!=='buffered')return;
  if(!claimed){claimed=true;p.setReviewIds(p.store.all('ready').slice(0,16).map(r=>r.id));}
  else if(s.backlog.ahead_reels===32&&s.backlog.reviewing_reels===16)p.pause();
 });
 await p.run({buffer:3});assert.equal(p.state.status,'paused');assert.equal(counts().downloads,48);
 assert.equal(p.backlog().target,32);assert.equal(p.backlog().ahead_reels,32);assert.equal(p.backlog().reviewing_reels,16);assert.equal(p.store.counts().pending,1);
});
