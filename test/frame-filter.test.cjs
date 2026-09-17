const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),sharp=require('sharp');
const {FrameFilter,geometry,verifiedCompletion}=require('../lib/frame-filter.cjs'),C=require('../lib/frame-filter-config.cjs');
const {PreparationPipeline}=require('../lib/pipeline.cjs'),{ReviewEngine}=require('../lib/engine.cjs'),S=require('../lib/storage.cjs');
const cue=C.CATALOG[0].id,primary={id:'test/primary',name:'Primary',pricing:{},supported:[]};
const no={decision:'no',cue:'none',evidence:'Only test patterns are visible.',location:'',box:null,confidence:.9,cost:.01};
const assets={hash:'test-assets',manifest:{revision:'test'},thresholds:Object.fromEntries(C.CATALOG.map(c=>[c.id,.5])),validation:'unvalidated'};
const scores=value=>Object.fromEntries(C.CATALOG.map(c=>[c.id,value]));
async function fixture(t,{count=6,scorer,screenOnPrepare=false,workerCount=3}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-filter-'));
 const media={resolveMedia:async url=>({url,direct:true,scope:'segment',segment_start:10,segment_end:10+count}),download:async(r,folder)=>{const p=path.join(folder,'source.mp4');await fs.writeFile(p,'SYNTHETIC MEDIA '+r.url);return p;},makeCards:async(_file,folder)=>{
  await fs.mkdir(folder,{recursive:true});const cw=160,ch=150,cards=[];
  for(let first=0;first<count;first+=16){const items=[];for(let i=0;i<Math.min(16,count-first);i++){const red=(first+i)%2===0;const input=await sharp({create:{width:cw,height:ch-30,channels:3,background:red?'#ff0000':'#0000ff'}}).png().toBuffer();items.push({input,left:4+(i%4)*(cw+4),top:4+Math.floor(i/4)*(ch+4)});}
   const name=`card_${String(cards.length+1).padStart(6,'0')}.jpg`;await sharp({create:{width:cw*4+20,height:ch*4+20,channels:3,background:'#151c23'}}).composite(items).jpeg({quality:100}).toFile(path.join(folder,name));cards.push({name,first_frame:first,frames:Math.min(16,count-first)});
  }return{duration:count,scope:'segment',segment_start:10,segment_end:10+count,fps:1,frame_count:count,card_count:cards.length,tile_columns:4,tile_rows:4,cell_width:cw,cell_height:ch,cards};}
 };
 let inferences=0;
 const filter=new FrameFilter({assets,workerCount,scorer:async image=>{inferences++;if(scorer)return scorer(image);const stats=await sharp(image).stats();return scores(stats.channels[0].mean>stats.channels[2].mean?.9:.1);}});
 const p=new PreparationPipeline({tools:{},media,frameFilter:filter,getFrameFilter:()=>({version:2,enabled:screenOnPrepare,cues:[cue]})});await p.open(root);p.usage=async()=>({bytes:100,free:100*1024**3});
 const urls=path.join(root,'urls.txt');await fs.writeFile(urls,'https://example.test/reel.mp4');p.store.import(urls);await p.run();
 const video=(await S.discover(root)).videos[0];
 t.after(async()=>{await filter.close();await p.liveWrite;p.store.close();const absolute=await fs.realpath(root);assert.ok(absolute.startsWith(await fs.realpath(os.tmpdir())));await fs.rm(absolute,{recursive:true,force:true});});
 const options={root,key:'SYNTHETIC',primary,workers:1,budget:100,frameFilter:{version:2,enabled:true,cues:[cue]}};
 const screen=()=>filter.screen({root,video,config:options.frameFilter,sourceFingerprint:video.expectedFingerprint,cardSignature:S.fingerprintCards(video)});
 return{root,p,filter,video,options,inferences:()=>inferences};
}
function engine(f,reviewer=async()=>no){return new ReviewEngine({frameFilter:f.filter,reviewer,prepareCard:async()=>{throw new Error('Unfiltered images must not be used');},rateLimitOptions:{spacingMs:0}});}
test('checklist validation, independent matching, receipt geometry and exact timestamps',()=>{
 assert.throws(()=>C.normalize({enabled:true,cues:[]}),/at least one/);assert.throws(()=>C.normalize({enabled:true,cues:['unknown']}),/checklist/);
 assert.deepEqual(C.match(scores(.1),{enabled:true,cues:[cue]},assets.thresholds),[]);
 const r={tile_columns:4,tile_rows:4,fps:2,cell_width:960,cell_height:570,segment_start:42};
 const a=geometry(r,{first_frame:16,frames:3},{width:3860,height:2300});assert.equal(a.length,3);assert.equal(a[0].timestamp,50);assert.equal(a[2].timestamp,51);assert.equal(a[0].rect.height,540);assert.equal(a[2].rect.left,1932);
 assert.throws(()=>geometry(r,{first_frame:0,frames:1},{width:3859,height:2300}),/dimensions/);
});
test('both classifiers receive only whole selected frames and preserve source mappings',async t=>{
 const f=await fixture(t);const sent=[];const e=engine(f,async({image})=>{sent.push(image);return no;});await e.run({...f.options,secondary:{...primary,id:'test/secondary'},verificationMode:'all'});
 assert.equal(e.state.status,'complete',e.state.message);assert.equal(sent.length,2);assert.equal(sent[0].data,sent[1].data);
 const image=sent[0];assert.deepEqual(image.frameMap.map(f=>f.index),[0,2,4]);assert.ok(image.frameMap.every(f=>f.bounds.width===160&&f.bounds.height===120));
 for(const m of image.frameMap){const b=m.bounds,crop=await sharp(Buffer.from(image.data,'base64')).extract({left:b.x+8,top:b.y+8,width:b.width-16,height:b.height-16}).png().toBuffer(),stats=await sharp(crop).stats();assert.ok(stats.channels[0].mean>240,JSON.stringify({frame:m.index,channels:stats.channels}));assert.ok(stats.channels[2].mean<10);}
 const entry=(await S.loadLedger(f.root)).entries[0];assert.equal(entry.verdict,'filtered_no');assert.equal(entry.filter.frames_screened,6);assert.equal(entry.filter.frames_selected,3);assert.equal(e.state.framesReviewed,3);
 assert.equal(await verifiedCompletion(f.root,entry,f.video.prepared),true);await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'cleaned');assert.equal(await S.exists(path.join(f.root,'frames',f.video.id)),false);assert.equal(await S.exists(path.resolve(f.root,entry.filter.manifest_path)),true);
});
test('zero candidates produce no paid requests and permit cleanup only after completion',async t=>{
 const f=await fixture(t,{scorer:async()=>scores(.01)});const e=engine(f,()=>{throw new Error('No request expected');});await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);
 const entry=(await S.loadLedger(f.root)).entries[0];assert.equal(entry.verdict,'filtered_no');assert.equal(entry.filter.frames_selected,0);assert.equal(await verifiedCompletion(f.root,entry,f.video.prepared),true);
 const records=path.resolve(f.root,entry.filter.manifest_path.replace(/\.json$/,'.reviews.json'));const bytes=await fs.readFile(records);await fs.unlink(records);await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'ready');await fs.writeFile(records,bytes);f.p.cleanupRetries.clear();await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'cleaned');
});
test('partial final sheets exclude padding and inference is cached on repeat screening',async t=>{
 const f=await fixture(t,{count:17});const args={root:f.root,video:f.video,config:f.options.frameFilter,sourceFingerprint:f.video.expectedFingerprint,cardSignature:await S.fingerprintCards(f.video)};
 const a=await f.filter.screen(args),calls=f.inferences(),b=await f.filter.screen(args);assert.equal(a.frame_count,17);assert.equal(a.selected_count,9);assert.equal(a.frames.at(-1).timestamp,26);assert.equal(f.inferences(),calls);assert.equal(a.fingerprint,b.fingerprint);assert.ok(b.cache_hits>=17);
});
test('pause during AI verification resumes saved primary with stable filter manifest',async t=>{
 const f=await fixture(t,{count:12});let calls=0,e;e=engine(f,async()=>{calls++;if(calls===2)e.pause();return no;});await e.run({...f.options,secondary:{...primary,id:'test/secondary'},verificationMode:'all'});assert.equal((await S.loadLedger(f.root)).entries.length,0);
 await e.run({...f.options,secondary:{...primary,id:'test/secondary'},verificationMode:'all'});assert.equal(e.state.status,'complete',e.state.message);assert.equal(calls,4);assert.equal((await S.loadLedger(f.root)).entries[0].filter.frames_selected,6);
});
test('failed local inference sends no images, preserves source, and is retryable on next run',async t=>{
 let broken=true;const f=await fixture(t,{scorer:async()=>{if(broken)throw new Error('Local inference failed');return scores(.01);}});const e=engine(f,()=>{throw new Error('No request expected');});await e.run(f.options);assert.equal(e.state.status,'attention');assert.equal((await S.loadLedger(f.root)).entries.length,0);await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'ready');broken=false;await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);
});
test('corrupt geometry never falls back to unscreened uploads',async t=>{
 const f=await fixture(t);const file=path.join(f.root,'frames',f.video.id,'prepared.json'),r=await S.readJson(file);r.cell_width++;await S.atomicJson(file,r);const e=engine(f,()=>{throw new Error('No request expected');});await e.run(f.options);assert.equal(e.state.status,'attention');assert.equal((await S.loadLedger(f.root)).entries.length,0);
});
test('a hit preserves candidate evidence and does not authorize negative cleanup',async t=>{
 const f=await fixture(t);const e=engine(f,async()=>({decision:'hit',cue:'judaica',evidence:'A test ritual object is present.',location:'First frame',box:[.1,.1,.2,.2],confidence:.9,cost:.01}));await e.run(f.options);const entry=(await S.loadLedger(f.root)).entries[0];assert.equal(entry.verdict,'jewish');assert.equal(entry.evidence.frame_map[0].index,0);assert.equal(await S.exists(path.resolve(f.root,entry.evidence.card_path)),true);await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'hit');
});
test('missing or modified bundled model assets fail before inference',async t=>{
 const f=await fixture(t);const filter=new FrameFilter({modelPath:path.join(f.root,'absent')});await assert.rejects(()=>filter.ready(),/missing|incompatible/);
});
test('changing model assets invalidates unfinished AI results and cached pixel scores',async t=>{
 const f=await fixture(t,{count:12});let calls=0,e;e=engine(f,async()=>{calls++;if(calls===1)e.pause();return no;});await e.run(f.options);const inferenceCount=f.inferences();
 f.filter.assets={...assets,hash:'test-assets-updated'};await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);assert.equal(calls,3);assert.ok(f.inferences()>inferenceCount);
});
test('skipped frames and AI failures never authorize cleanup',async t=>{
 const f=await fixture(t);const e=engine(f,async()=>{throw new Error('Simulated failed classification');});await e.run(f.options);assert.equal(e.state.status,'error');await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'ready');assert.equal((await S.loadLedger(f.root)).entries.length,0);
});
test('same-source filtered result is reused only with compatible filter configuration',async t=>{
 const f=await fixture(t);let calls=0;const e=engine(f,async()=>{calls++;return no;});await e.run(f.options);
 const old=(await S.loadLedger(f.root)).entries[0],alias='alias-same';
 const dir=path.join(f.root,'frames',alias);await fs.mkdir(path.join(dir,'cards'),{recursive:true});
 const receipt={...f.video.prepared,id:alias,shared_from:f.video.id};await S.atomicJson(path.join(dir,'prepared.json'),receipt);await S.atomicJson(path.join(dir,'.reelsight-owned.json'),{token:f.p.token,relative:`frames/${alias}`});
 await e.run(f.options);assert.equal(calls,1);const copy=(await S.loadLedger(f.root)).entries.find(v=>v.id===alias);assert.equal(copy.verdict,'filtered_no');assert.equal(copy.copied_from,old.id);
 // Reintroduce only the original result and change the filter: no copy and no fallback to unscreened imagery.
 await S.atomicJson(path.join(f.root,'chat_verdicts.json'),[old]);await e.run({...f.options,frameFilter:{version:2,enabled:false,cues:['people']}});assert.equal((await S.loadLedger(f.root)).entries.length,1);assert.equal(e.state.status,'attention');assert.equal(calls,1);
});
test('screening cancellation saves no verdict and releases the queue for resume',async t=>{
 const f=await fixture(t);const e=engine(f);let cancelled=false;e.on('state',s=>{if(!cancelled&&s.framesScreened===1){cancelled=true;e.pause();}});await e.run(f.options);assert.equal(e.state.status,'paused');assert.equal((await S.loadLedger(f.root)).entries.length,0);await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);
});
test('an incomplete cached score cannot turn a frame into an automatic negative',async t=>{
 const f=await fixture(t);const args={root:f.root,video:f.video,config:f.options.frameFilter,sourceFingerprint:f.video.expectedFingerprint,cardSignature:await S.fingerprintCards(f.video)};await f.filter.screen(args);
 const cachePath=path.join(f.root,'frames',f.video.id,'filter-scores','test-assets.json'),cache=await S.readJson(cachePath);for(const key of Object.keys(cache.scores))cache.scores[key]={};await S.atomicJson(cachePath,cache);
 // Force rebuilding: a verified, complete manifest does not depend on unused score-cache bytes.
 await fs.unlink(path.resolve(f.root,(await f.filter.prepared(args)).manifest_path));
 const e=engine(f,()=>{throw new Error('No request expected');});await e.run(f.options);assert.equal(e.state.status,'attention');assert.equal((await S.loadLedger(f.root)).entries.length,0);await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'ready');
});
test('preparation publishes candidates atomically and review skips decoding and inference',async t=>{
 const f=await fixture(t,{count:17,screenOnPrepare:true});assert.equal(f.p.state.status,'complete');assert.ok(f.inferences()>0);
 const manifest=await f.filter.prepared({root:f.root,video:f.video,config:f.options.frameFilter,sourceFingerprint:f.video.expectedFingerprint,cardSignature:await S.fingerprintCards(f.video)});
 assert.equal(manifest.frames.length,17);assert.equal(manifest.selected_count,9);assert.ok(manifest.frames.every(v=>!v.source_path.includes('staging')));assert.ok(manifest.sheets.every(v=>!v.path.includes('staging')));
 const count=f.inferences();f.filter._screen=async()=>{throw new Error('Review must load prepared sheets directly');};let calls=0;
 const e=engine(f,async()=>{calls++;return no;});await e.run(f.options);assert.equal(e.state.status,'complete',e.state.message);assert.equal(calls,3);assert.equal(f.inferences(),count);
 await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'cleaned');
});
test('zero-candidate preparation saves no verdict; review commits durable filtered negative without AI',async t=>{
 const f=await fixture(t,{screenOnPrepare:true,scorer:async()=>scores(0)});
 assert.equal((await S.loadLedger(f.root)).entries.length,0);assert.equal(f.p.store.get(f.video.id).status,'ready');
 const e=engine(f,()=>{throw new Error('No paid call permitted');});await e.run(f.options);assert.equal(e.state.status,'complete');
 await f.p.syncVerdicts();assert.equal(f.p.store.get(f.video.id).status,'cleaned');
});
test('failed preparation screening exposes no unscreened cards and retry preserves downloaded source',async t=>{
 const f=await fixture(t,{screenOnPrepare:true,scorer:async()=>{throw new Error('Local model failed');}});
 assert.equal(f.p.store.counts().error,1);assert.equal((await S.discover(f.root)).videos.length,0);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 const row=f.p.store.all('error')[0];assert.equal(await S.exists(path.join(f.root,'.pipeline','media',row.id,'source.mp4')),true);
 f.filter.scorer=async()=>scores(.9);f.p.store.retry();await f.p.run();assert.equal(f.p.store.counts().ready,1);
 const video=(await S.discover(f.root)).videos[0];assert.equal((await f.filter.prepared({root:f.root,video,config:f.options.frameFilter,sourceFingerprint:video.expectedFingerprint,cardSignature:await S.fingerprintCards(video)})).selected_count,6);
});
test('already prepared footage is screened ahead when filtering is enabled',async t=>{
 const f=await fixture(t);f.p.getFrameFilter=()=>f.options.frameFilter;
 f.p.media.makeCards=async()=>{throw new Error('Must not re-extract existing footage');};await f.p.run();assert.equal(f.p.store.counts().ready,1);assert.ok(f.inferences()>0);
 const before=f.inferences();await f.p.run();assert.equal(f.inferences(),before);
});
test('preparation respects deferred IDs instead of rescanning their old footage',async t=>{
 const f=await fixture(t);f.p.getFrameFilter=()=>f.options.frameFilter;f.p.setDeferredIds([f.video.id]);
 await f.p.run();assert.equal(f.inferences(),0);assert.equal(f.p.state.status,'complete');
 f.p.setDeferredIds([]);await f.p.run();assert.ok(f.inferences()>0);
});
test('prepared review returns directly and rejects changed sheets or geometry',async t=>{
 const f=await fixture(t,{screenOnPrepare:true});const args={root:f.root,video:f.video,config:f.options.frameFilter,sourceFingerprint:f.video.expectedFingerprint,cardSignature:await S.fingerprintCards(f.video),reusePrepared:true};
 const m=await Promise.race([f.filter.screen(args),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Prepared review was unexpectedly blocked')),1000))]);
 assert.equal(m.prepared,true);assert.equal(await f.filter.prepared({...args,video:{...f.video,prepared:{...f.video.prepared,cell_width:161}}}),null);
 await fs.appendFile(path.resolve(f.root,m.sheets[0].path),'changed');assert.equal(await f.filter.prepared(args),null);
});
test('pause during preparation screening never publishes half-screened footage and resumes',async t=>{
 const f=await fixture(t);const row=f.p.store.all('ready')[0];
 f.p.getFrameFilter=()=>f.options.frameFilter;let once=false;f.p.on('screening',()=>{if(!once){once=true;f.p.pause();}});
 await f.p.run();assert.equal(f.p.state.status,'paused');assert.equal(f.p.store.get(row.id).status,'pending');assert.equal((await S.loadLedger(f.root)).entries.length,0);
 await f.p.run();assert.equal(f.p.store.get(row.id).status,'ready');assert.equal(f.p.state.status,'complete');
});

test('parallel screening preserves single-worker manifests and saves drained scores on pause',async t=>{
 const f=await fixture(t,{count:17,workerCount:3});let active=0,peak=0;
 const original=f.filter.scorer;f.filter.scorer=async image=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,15));return await original(image);}finally{active--;}};
 const args={root:f.root,video:f.video,config:f.options.frameFilter,sourceFingerprint:f.video.expectedFingerprint,cardSignature:await S.fingerprintCards(f.video)};
 let stopped=false;await assert.rejects(f.filter.screen({...args,stopped:()=>stopped,onProgress:()=>{stopped=true;}}),e=>e.filterCancelled);
 assert.equal(active,0);assert.ok(peak>1&&peak<=3);assert.equal((await S.loadLedger(f.root)).entries.length,0);
 assert.equal(await f.filter.prepared(args),null);
 const cacheFile=path.join(f.root,'frames',f.video.id,'filter-scores','test-assets.json');
 assert.ok(Object.keys((await S.readJson(cacheFile)).scores).length>0);
 const parallel=await f.filter.screen(args);assert.ok(parallel.cache_hits>0);
 await fs.unlink(cacheFile);
 const sequential=new FrameFilter({assets,workerCount:1,scorer:original});
 try{const baseline=await sequential.screen(args);assert.equal(parallel.fingerprint,baseline.fingerprint);assert.deepEqual(parallel.frames.map(f=>f.index),Array.from({length:17},(_,i)=>i));assert.deepEqual(parallel.sheets,baseline.sheets);}
 finally{await sequential.close();}
});
