const test=require('node:test'),assert=require('node:assert/strict'),os=require('node:os'),fs=require('node:fs/promises'),path=require('node:path');
const {QueueStore}=require('../lib/queue.cjs');const S=require('../lib/storage.cjs');const F=require('../lib/footagefarm.cjs');
test('queue keeps source membership and switches active work without duplicating URLs',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-switch-')),a=path.join(root,'a.json'),b=path.join(root,'b.json');await fs.writeFile(a,JSON.stringify({items:[{url:'https://example.com/one'},{url:'https://example.com/shared'}]}));await fs.writeFile(b,JSON.stringify({items:[{url:'https://example.com/two'},{url:'https://example.com/shared'}]}));const q=new QueueStore(root);q.import(a,{sourceKey:'a',label:'A'});q.import(b,{sourceKey:'b',label:'B'});const shared=q.db.prepare("select id from items where url like '%shared%'").get().id;q.update(shared,{status:'ready',media_key:'same',owner_id:shared});q.setActiveSource('b');assert.equal(q.counts().total,2);assert.equal(q.shared('same','missing').id,shared);q.setActiveSource('a');assert.equal(q.counts().total,2);q.setActiveSource(null);assert.equal(q.counts().total,3);assert.deepEqual(q.sourcesList().map(x=>[x.key,x.total]),[['a',2],['b',2]]);assert.throws(()=>q.setActiveSource('unavailable'),/Choose an imported source/);q.close();});
test('Footage Farm parser finds public catalog hierarchy and stable numeric reels',()=>{const html='<a href="https://footagefarm.com/subthemes/wwi/trenches">X</a><a href="https://footagefarm.com/reel-details/wwi/trenches/a-reel">A</a><span data-url="https://footagefarm.com/reel-details/123/10"></span>';assert.deepEqual(F.links(html,new RegExp('^/subthemes/[^/]+/[^/]+$')),['https://footagefarm.com/subthemes/wwi/trenches']);assert.deepEqual(F.links(html,new RegExp('^/reel-details/\\d+/\\d+$')),['https://footagefarm.com/reel-details/123/10']);});
test('selected source exposes only its prepared videos and verdicts',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'source-view-'));await fs.mkdir(path.join(root,'frames','a','cards'),{recursive:true});await fs.mkdir(path.join(root,'frames','b','cards'),{recursive:true});await fs.writeFile(path.join(root,'frames','a','cards','card_1.jpg'),'a');await fs.writeFile(path.join(root,'frames','b','cards','card_1.jpg'),'b');await fs.writeFile(path.join(root,'reelsight_manifest.json'),JSON.stringify([{id:'a',source_key:'source-a'},{id:'b',source_key:'source-b'}]));await fs.writeFile(path.join(root,'chat_verdicts.json'),JSON.stringify([{id:'done-a',source_key:'source-a',verdict:'no'},{id:'done-b',source_key:'source-b',verdict:'jewish'}]));const view=await S.discover(root,{sourceKey:'source-b'});assert.deepEqual(view.videos.map(v=>v.id),['b']);assert.deepEqual(view.entries.map(v=>v.id),['done-b']);});
test('improved Footage Farm resolver retries old failures and separates unavailable previews',async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'ff-retry-')),file=path.join(root,'ff.json');await fs.writeFile(file,JSON.stringify({items:[{id:1,url:'https://footagefarm.com/reel-details/a/b/c'},{id:2,url:'https://footagefarm.com/reel-details/a/b/d'},{id:3,url:'https://footagefarm.com/reel-details/a/b/e'}]}));const q=new QueueStore(root);q.import(file,{sourceKey:'footagefarm',label:'Footage Farm'});for(const row of q.db.prepare('select id from items order by id').all())q.update(row.id,{status:'error',error:row.id==='ff-1'?'yt-dlp.exe failed: Unsupported URL: https://footagefarm.com/x':row.id==='ff-2'?'fetch failed':'PREVIEW_UNAVAILABLE: Footage Farm has no online screener'});assert.equal(q.classifyPreviewUnavailable(),1);assert.equal(q.retryLegacyFootageFarmFailures(),2);assert.deepEqual(q.db.prepare('select status from items order by id').all().map(x=>x.status),['pending','pending','unavailable']);q.close();});
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
