const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const {QueueStore}=require('../lib/queue.cjs');const S=require('../lib/storage.cjs');const F=require('../lib/footagefarm.cjs');
test('queue keeps source membership and switches active work without duplicating URLs',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-switch-')),a=path.join(root,'a.json'),b=path.join(root,'b.json');await fs.writeFile(a,JSON.stringify({items:[{url:'https://example.com/one'},{url:'https://example.com/shared'}]}));await fs.writeFile(b,JSON.stringify({items:[{url:'https://example.com/two'},{url:'https://example.com/shared'}]}));const q=new QueueStore(root);q.import(a,{sourceKey:'a',label:'A'});q.import(b,{sourceKey:'b',label:'B'});const shared=q.db.prepare("select id from items where url like '%shared%'").get().id;q.update(shared,{status:'ready',media_key:'same',owner_id:shared});q.setActiveSource('b');assert.equal(q.counts().total,2);assert.equal(q.shared('same','missing').id,shared);q.setActiveSource('a');assert.equal(q.counts().total,2);q.setActiveSource(null);assert.equal(q.counts().total,3);assert.deepEqual(q.sourcesList().map(x=>[x.key,x.total]),[['a',2],['b',2]]);assert.throws(()=>q.setActiveSource('unavailable'),/Choose an imported source/);q.close();});
test('website source can be registered without URLs or network access',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'empty-source-')),q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});const added=q.registerSource({sourceKey:'myfootage',label:'MyFootage',homepage:'https://www.myfootage.com/'});assert.equal(added.total,0);assert.deepEqual(q.sourcesList().map(row=>({key:row.key,label:row.label,kind:row.kind,total:row.total})),[{key:'myfootage',label:'MyFootage',kind:'website',total:0}]);q.setActiveSource('myfootage');assert.equal(q.counts().total,0);});
test('imported MyFootage clip URLs use one isolated source and stable canonical IDs',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'myfootage-queue-')),file=path.join(root,'clips.txt');await fs.writeFile(file,'https://www.myfootage.com/109285-mlk.html\nhttps://www.myfootage.com/pix/109/109286-second.mp4\n');const q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});const result=q.import(file);assert.equal(result.sourceKey,'myfootage');assert.equal(result.label,'MyFootage');assert.deepEqual(q.rows().map(row=>[row.id,row.url]),[['mf-109285','https://www.myfootage.com/preview.asp?item=109285'],['mf-109286','https://www.myfootage.com/preview.asp?item=109286']]);assert.deepEqual(q.sourcesList().map(row=>[row.key,row.total]),[['myfootage',2]]);});
test('queue update skips fully durable no-op writes and preserves updated_at',async t=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-noop-')),file=path.join(root,'items.json');await fs.writeFile(file,JSON.stringify({items:[{url:'https://example.com/one'}]}));const q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});q.import(file);const row=q.db.prepare('SELECT * FROM items').get();assert.equal(q.update(row.id,{status:row.status,error:row.error,bytes:row.bytes}),0);assert.equal(q.get(row.id).updated_at,row.updated_at);await new Promise(resolve=>setTimeout(resolve,5));assert.equal(q.update(row.id,{status:'ready'}),1);assert.notEqual(q.get(row.id).updated_at,row.updated_at);});
test('corrected Footage Farm crawl preserves work by canonical URL and drops empty numeric shells',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-reconcile-')),oldFile=path.join(root,'old.json'),fixedFile=path.join(root,'fixed.json');
 const numeric='https://footagefarm.com/reel-details/1/10',a='https://footagefarm.com/reel-details/theme/sub/a',b='https://footagefarm.com/reel-details/theme/sub/b',c='https://footagefarm.com/reel-details/theme/sub/c';
 await fs.writeFile(oldFile,JSON.stringify({items:[{id:1,url:numeric,title:'shell'},{id:2,url:a,title:'old A'},{id:3,url:b,title:'old B'}]}));
 const q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});q.import(oldFile,{sourceKey:'footagefarm',label:'Footage Farm',kind:'crawled'});
 q.update('ff-2',{status:'hit',source_hash:'hash-a',owner_id:'ff-2'});q.update('ff-3',{status:'unavailable',error:'PREVIEW_UNAVAILABLE: old'});
 await fs.writeFile(fixedFile,JSON.stringify({items:[{id:1,url:a,title:'A'},{id:2,url:b,title:'B'},{id:3,url:c,title:'C'}]}));
 const result=q.import(fixedFile,{sourceKey:'footagefarm',label:'Footage Farm',kind:'crawled'});
 assert.equal(result.added,1);assert.ok(result.reconciled>=2);
 assert.equal(q.db.prepare('SELECT status FROM items WHERE url=?').get(a).status,'hit');
 assert.equal(q.db.prepare('SELECT catalog_id FROM items WHERE url=?').get(a).catalog_id,'1');
 assert.equal(q.db.prepare('SELECT status FROM items WHERE url=?').get(b).status,'unavailable');
 const cRow=q.db.prepare('SELECT id,status FROM items WHERE url=?').get(c);assert.match(cRow.id,/^ff-url-/);assert.equal(cRow.status,'pending');
 const active=q.db.prepare('SELECT i.url FROM items i JOIN item_sources s ON s.item_id=i.id WHERE s.source_key=? ORDER BY i.url').all('footagefarm').map(row=>row.url);
 assert.deepEqual(active,[a,b,c].sort());assert.ok(!active.includes(numeric));
});
test('Footage Farm parser finds public catalog hierarchy and stable numeric reels',()=>{const html='<a href="https://footagefarm.com/subthemes/wwi/trenches">X</a><a href="https://footagefarm.com/reel-details/wwi/trenches/a-reel">A</a><span data-url="https://footagefarm.com/reel-details/123/10"></span>';assert.deepEqual(F.links(html,new RegExp('^/subthemes/[^/]+/[^/]+$')),['https://footagefarm.com/subthemes/wwi/trenches']);assert.deepEqual(F.links(html,new RegExp('^/reel-details/\\d+/\\d+$')),['https://footagefarm.com/reel-details/123/10']);});
test('selected source scopes active work while saved hits remain visible workspace-wide',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-view-'));await fs.mkdir(path.join(root,'frames','a','cards'),{recursive:true});await fs.mkdir(path.join(root,'frames','b','cards'),{recursive:true});await fs.writeFile(path.join(root,'frames','a','cards','card_1.jpg'),'a');await fs.writeFile(path.join(root,'frames','b','cards','card_1.jpg'),'b');await fs.writeFile(path.join(root,'reelsight_manifest.json'),JSON.stringify([{id:'a',source_key:'source-a'},{id:'b',source_key:'source-b'}]));await fs.writeFile(path.join(root,'chat_verdicts.json'),JSON.stringify([{id:'done-a',source_key:'source-a',verdict:'jewish'},{id:'done-b',source_key:'source-b',verdict:'jewish'},{id:'no-a',source_key:'source-a',verdict:'no'}]));const view=await S.discover(root,{sourceKey:'source-b'});assert.deepEqual(view.videos.map(v=>v.id),['b']);assert.deepEqual(view.entries.map(v=>v.id),['done-b']);assert.deepEqual(view.workspaceHits.map(v=>v.id),['done-a','done-b']);});
test('selected source ignores incomplete published cards owned by another source',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-coverage-')),token='source-owner';t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'.pipeline'),{recursive:true});await fs.writeFile(path.join(root,'.pipeline','owner.json'),JSON.stringify({token}));
 const rows=[['a','source-a',false],['b','source-b',true]];
 for(const[id,source_key,complete]of rows){
  const cards=path.join(root,'frames',id,'cards');await fs.mkdir(cards,{recursive:true});
  if(complete)await fs.writeFile(path.join(cards,'card_1.jpg'),id);
  const receipt={id,token,source_key,scope:'whole-reel',source_fingerprint:`mp4-sha256:${id}`,cards:[{name:'card_1.jpg'}],card_count:1};
  await fs.writeFile(path.join(root,'frames',id,'prepared.json'),JSON.stringify(receipt));
  await fs.writeFile(path.join(root,'frames',id,'.reelsight-owned.json'),JSON.stringify({token,relative:`frames/${id}`}));
 }
 await fs.writeFile(path.join(root,'reelsight_manifest.json'),JSON.stringify(rows.map(([id,source_key])=>({id,source_key}))));
 const sourceB=await S.discover(root,{sourceKey:'source-b'});assert.deepEqual(sourceB.videos.map(v=>v.id),['b']);assert.deepEqual(sourceB.issues,[]);assert.deepEqual([...sourceB.scopeIds],['b']);
 const sourceA=await S.discover(root,{sourceKey:'source-a'});assert.deepEqual(sourceA.videos,[]);assert.equal(sourceA.issues.length,1);assert.equal(sourceA.issues[0].id,'a');assert.equal(sourceA.issues[0].source_key,'source-a');assert.match(sourceA.issues[0].message,/coverage/);
});
test('receipt-only source membership retains an active-source coverage error',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'receipt-source-')),id='receipt-only',token='source-owner';t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const cards=path.join(root,'frames',id,'cards');await fs.mkdir(cards,{recursive:true});await fs.mkdir(path.join(root,'.pipeline'),{recursive:true});
 await fs.writeFile(path.join(root,'.pipeline','owner.json'),JSON.stringify({token}));await fs.writeFile(path.join(root,'frames',id,'.reelsight-owned.json'),JSON.stringify({token,relative:`frames/${id}`}));
 await fs.writeFile(path.join(root,'frames',id,'prepared.json'),JSON.stringify({id,token,source_key:'source-b',scope:'whole-reel',source_fingerprint:'mp4-sha256:receipt-only',cards:[{name:'card_1.jpg'}],card_count:1}));
 const sourceB=await S.discover(root,{sourceKey:'source-b'});assert.deepEqual(sourceB.videos,[]);assert.equal(sourceB.issues.length,1);assert.equal(sourceB.issues[0].id,id);assert.equal(sourceB.issues[0].source_key,'source-b');
 const sourceA=await S.discover(root,{sourceKey:'source-a'});assert.deepEqual(sourceA.issues,[]);
});
test('improved Footage Farm resolver retries old failures and separates unavailable previews',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-retry-')),file=path.join(root,'ff.json');await fs.writeFile(file,JSON.stringify({items:[{id:1,url:'https://footagefarm.com/reel-details/a/b/c'},{id:2,url:'https://footagefarm.com/reel-details/a/b/d'},{id:3,url:'https://footagefarm.com/reel-details/a/b/e'}]}));const q=new QueueStore(root);q.import(file,{sourceKey:'footagefarm',label:'Footage Farm'});for(const row of q.db.prepare('select id from items order by id').all())q.update(row.id,{status:'error',error:row.id==='ff-1'?'yt-dlp.exe failed: Unsupported URL: https://footagefarm.com/x':row.id==='ff-2'?'fetch failed':'PREVIEW_UNAVAILABLE: Footage Farm has no online screener'});assert.equal(q.classifyPreviewUnavailable(),1);assert.equal(q.retryLegacyFootageFarmFailures(),2);assert.deepEqual(q.db.prepare('select status from items order by id').all().map(x=>x.status),['pending','pending','unavailable']);q.close();});
test('verified Vimeo resolver migration requeues unavailable Footage Farm rows exactly once',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-vimeo-retry-')),file=path.join(root,'ff.json');await fs.writeFile(file,JSON.stringify({items:[{id:1,url:'https://footagefarm.com/reel-details/a/b/c'},{id:2,url:'https://example.org/two'}]}));
 const q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});q.import(file,{sourceKey:'footagefarm'});
 q.update('ff-1',{status:'unavailable',attempts:4,error:'PREVIEW_UNAVAILABLE: no direct screener'});const other=q.db.prepare("SELECT id FROM items WHERE id<>'ff-1'").get().id;q.update(other,{status:'unavailable',error:'PREVIEW_UNAVAILABLE: unrelated'});
 assert.equal(q.requeueFootageFarmUnavailable(),1);assert.equal(q.get('ff-1').status,'pending');assert.equal(q.get('ff-1').attempts,0);assert.equal(q.get(other).status,'unavailable');
 q.update('ff-1',{status:'unavailable',error:'PREVIEW_UNAVAILABLE: still unavailable'});assert.equal(q.requeueFootageFarmUnavailable(),0);assert.equal(q.get('ff-1').status,'unavailable');
 const authError='Vimeo access is required for this Footage Farm screener. Choose access in Settings.';q.update('ff-1',{status:'error',error:authError});assert.equal(q.retryVimeoAuthenticationRequired(),1);assert.equal(q.get('ff-1').status,'pending');assert.equal(q.get('ff-1').error,authError);assert.equal(q.retryVimeoAuthenticationRequired(),0);
 q.update('ff-1',{status:'error',error:'Scrapfly access is required while Vimeo is rate-limiting the public Footage Farm catalog lookup. Add a Scrapfly API key in Connection & settings.'});assert.equal(q.retryScrapflyRequired(),1);assert.equal(q.get('ff-1').status,'pending');
});
test('legacy Footage Farm media failures get bounded fresh resolver attempts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-media-retry-')),file=path.join(root,'ff.json');
 const cases=[
  ['terminated',1,true],
  ["yt-dlp.exe failed (1): Failed to resolve 'skyfire.vimeocdn.com' ([Errno 11001] getaddrinfo failed)",1,true],
  ['yt-dlp.exe failed (1): Failed to connect to player.vimeo.com:443; Could not connect to server',1,true],
  ['yt-dlp.exe failed (1): Connection closed abruptly',1,true],
  ['yt-dlp.exe failed (1): HTTP Error 404: Not Found',1,true],
  ['ffmpeg.exe failed (3199971767): Invalid NAL unit size. Error splitting the input into NAL units.',1,true],
  ['An existing folder is not owned by this preparation queue. It has been preserved.',2,true],
  ['fetch failed',5,true],
  ['fetch failed',12,false],
  ['terminated',3,false],
  ['yt-dlp.exe failed (1): Unsupported extractor with no public MP4',1,false]
 ];
 await fs.writeFile(file,JSON.stringify({items:cases.map((_,i)=>({id:i+1,url:`https://footagefarm.com/reel-details/a/b/${i+1}`}))}));
 const q=new QueueStore(root);t.after(async()=>{q.close();await fs.rm(root,{recursive:true,force:true});});
 q.import(file,{sourceKey:'footagefarm',label:'Footage Farm'});
 cases.forEach(([error,attempts],i)=>q.update(`ff-${i+1}`,{status:'error',error,attempts}));
 assert.equal(q.retryLegacyFootageFarmFailures(),8);
 const rows=q.db.prepare('SELECT id,status,error,attempts FROM items ORDER BY CAST(substr(id,4) AS INTEGER)').all();
 for(let i=0;i<cases.length;i++){
  const shouldRetry=cases[i][2];
  assert.equal(rows[i].status,shouldRetry?'pending':'error',rows[i].id);
  assert.equal(rows[i].error,shouldRetry?null:cases[i][0],rows[i].id);
  assert.equal(rows[i].attempts,cases[i][1],rows[i].id);
 }
 assert.equal(q.retryLegacyFootageFarmFailures(),0,'pending rows are not re-migrated');
});
