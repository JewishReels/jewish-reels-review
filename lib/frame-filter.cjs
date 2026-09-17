const fs=require('node:fs/promises');
const path=require('node:path');
const {ScreeningPool,screeningCapacity,parallelFrames}=require('./screening-pool.cjs');
const S=require('./storage.cjs');
const C=require('./frame-filter-config.cjs');
const sharp=require('sharp');
const interrupted=()=>Object.assign(new Error('Frame screening paused. Saved scores are retained.'),{filterCancelled:true});
const check=stopped=>{if(stopped?.())throw interrupted();};
function fail(message){return Object.assign(new Error(message),{inputUnavailable:true,filterError:true,code:'FRAME_FILTER_UNAVAILABLE'});}
function geometry(receipt,card,size){
 if(!receipt||receipt.tile_columns!==4||receipt.tile_rows!==4||![1,2,4].includes(receipt.fps)||!Number.isInteger(receipt.cell_width)||!Number.isInteger(receipt.cell_height)||receipt.cell_width<16||receipt.cell_height<46)throw fail('Frame geometry is unavailable. Prepare this video again before using the filter.');
 const w=receipt.cell_width,h=receipt.cell_height;
 if(size.width!==4*w+20||size.height!==4*h+20)throw fail('Contact-sheet dimensions do not match the preparation receipt. Prepare this video again.');
 if(!card||!Number.isInteger(card.first_frame)||!Number.isInteger(card.frames)||card.frames<1||card.frames>16)throw fail('Invalid prepared frame coverage.');
 return Array.from({length:card.frames},(_,i)=>({index:card.first_frame+i,timestamp:(receipt.segment_start||0)+(card.first_frame+i)/receipt.fps,rect:{left:4+(i%4)*(w+4),top:4+Math.floor(i/4)*(h+4),width:w,height:h-30},tileRect:{left:4+(i%4)*(w+4),top:4+Math.floor(i/4)*(h+4),width:w,height:h}}));
}
function verifyReceipt(video){
 const r=video.prepared;
 if(!r||r.shared_from||!Array.isArray(r.cards)||r.cards.length!==video.cards.length||r.card_count!==video.cards.length||r.source_fingerprint!==video.expectedFingerprint)throw fail('This video needs verified preparation receipts for frame filtering. Prepare it again.');
 let n=0;for(let i=0;i<r.cards.length;i++){const c=r.cards[i];if(c.name!==path.basename(video.cards[i])||c.first_frame!==n||!Number.isInteger(c.frames)||c.frames<1||c.frames>16||(i<r.cards.length-1&&c.frames!==16))throw fail('Prepared frame coverage is inconsistent.');n+=c.frames;}
 if(n!==r.frame_count)throw fail('Prepared frame count is incomplete.');
 if(r.scope==='segment'){
  const duration=r.segment_end-r.segment_start,minimum=Math.max(1,Math.floor(duration)),maximum=Math.ceil(duration*r.fps);
  if(!Number.isFinite(r.segment_start)||!Number.isFinite(r.segment_end)||r.segment_start<0||r.segment_end<=r.segment_start||n<minimum||n>maximum)throw fail('Story boundaries do not match frame coverage.');
 }
 return r;
}
function geometryKey(r){return C.hash({fps:r.fps,columns:r.tile_columns,rows:r.tile_rows,width:r.cell_width,height:r.cell_height,cards:r.cards,frames:r.frame_count,scope:r.scope,start:r.segment_start,end:r.segment_end});}
class FrameFilter {
 constructor({modelPath,scorer,assets,workerCount=screeningCapacity(),workerThreads}={}){this.modelPath=modelPath;this.scorer=scorer;this.assets=assets;this.workerCount=workerCount;this.pool=new ScreeningPool({modelPath,size:workerCount,threads:workerThreads});}
 async ready(){
  if(this.assets)return this.assets;
  if(!this.loading)this.loading=(async()=>{
   const manifest=await S.readJson(path.join(this.modelPath,'manifest.json'),null);
   if(!manifest||manifest.version!==1||manifest.catalog_hash!==C.CATALOG_HASH||manifest.preprocessing!==C.PREPROCESSING)throw fail('The bundled frame filter model is missing or incompatible. Reinstall this Jewish Reels build.');
   const expected=['config.json','preprocessor_config.json','onnx/vision_model_quantized.onnx','embeddings.json','thresholds.json'];
   for(const f of expected)if(!manifest.files[f]||await S.hashFile(path.join(this.modelPath,f))!==manifest.files[f])throw fail('Frame filter asset verification failed: '+f+'. Reinstall this build.');
   const thresholds=await S.readJson(path.join(this.modelPath,'thresholds.json'),null);
   if(!thresholds||C.CATALOG.some(c=>!Number.isFinite(thresholds.values?.[c.id])||thresholds.values[c.id]<-1||thresholds.values[c.id]>1))throw fail('Frame filter thresholds are invalid.');
   if(manifest.model!==C.MODEL||manifest.revision!==C.MODEL_REVISION||manifest.files['onnx/vision_model_quantized.onnx']!==C.VISION_SHA256)throw fail('The people filter model does not match its pinned revision. Reinstall this build.');
   require('./people-scoring.cjs').validateEmbeddings(await S.readJson(path.join(this.modelPath,'embeddings.json'),null));
   if(thresholds.embeddings_sha256!==manifest.files['embeddings.json'])throw fail('People calibration does not match its text embeddings. Reinstall this build.');
   return this.assets={hash:C.hash(manifest),manifest,thresholds:thresholds.values,validation:thresholds.status,calibration:thresholds.calibration||null};
  })().catch(e=>{this.loading=null;throw fail(e.message);});
  return this.loading;
 }
 async infer(bytes,options={}){if(this.scorer)return this.scorer(bytes,options);try{return await this.pool.run(bytes,options);}catch(e){throw fail(e.message);}}
 async prepared({root,video,config,sourceFingerprint,cardSignature,stopped,onProgress=()=>{}}){
  check(stopped);const assets=await this.ready(),r=verifyReceipt(video),cfg=C.normalize(config),key=C.fingerprint(cfg,assets.hash);
  const manifestPath=path.join(root,'logs','frame-filter',video.id,key+'.json'),m=await S.readJson(manifestPath,null);
  if(!m)return null;
  const {fingerprint,...body}=m;
  if(m.version!==1||!m.complete||fingerprint!==C.hash(body)||m.geometry_key!==geometryKey(r)||m.id!==video.id||m.source_fingerprint!==sourceFingerprint||m.card_signature!==cardSignature||m.filter_key!==key||m.asset_hash!==assets.hash||C.hash(m.config)!==C.hash(cfg))return null;
  if(!Array.isArray(m.frames)||m.frames.length!==r.frame_count||!Array.isArray(m.sheets))return null;
  const selected=m.frames.filter(f=>f.selected);
  if(m.selected_count!==selected.length||JSON.stringify(selected.map(f=>f.index))!==JSON.stringify(m.sheets.flatMap(s=>s.frames.map(f=>f.index))))return null;
  const base=path.resolve(root,'frames',video.id,'filtered',key);
  for(const sheet of m.sheets){
   check(stopped);const file=path.resolve(root,sheet.path);
   if(path.dirname(file)!==base||!await S.exists(file)||await S.hashFile(file)!==sheet.sha256)return null;
  }
  check(stopped);onProgress({id:video.id,screened:m.frame_count,total:m.frame_count,selected:m.selected_count,skipped:m.frame_count-m.selected_count,cacheHits:m.frame_count,status:'ready',prepared:true});
  return {...m,elapsed_ms:0,cache_hits:m.frame_count,prepared:true,manifest_path:path.relative(root,manifestPath)};
 }
 async screen(options){
  // Completed preparation bypasses inference. New videos share the bounded model pool.
  if(options.reusePrepared&&!options.artifactDirectory){const ready=await this.prepared(options);if(ready)return ready;}
  if(options.reusePrepared&&!options.artifactDirectory){const ready=await this.prepared(options);if(ready)return ready;}
  return this._screen(options);
 }
 async _screen({root,video,config,sourceFingerprint,cardSignature,artifactDirectory,stopped,onProgress=()=>{}}){
  check(stopped);const assets=await this.ready(),r=verifyReceipt(video),cfg=C.normalize(config),key=C.fingerprint(cfg,assets.hash);
  const published=path.join(root,'frames',video.id),artifact=artifactDirectory||published;
  if(artifactDirectory&&path.resolve(artifactDirectory)!==path.resolve(root,'.pipeline','staging',video.id))throw fail('Invalid preparation staging folder.');
  const assetDir=path.join(artifact,'filtered',key);
  const manifestPath=path.join(root,'logs','frame-filter',video.id,key+'.json');
  const cachePath=path.join(artifact,'filter-scores',assets.hash+'.json');
  let cache=await S.readJson(cachePath,{version:1,scores:{}});if(cache.version!==1||!cache.scores)throw fail('Frame score cache is invalid. Preserve it for diagnosis and prepare the video again.');
  const frames=[];let selected=0,cacheHits=0,screened=0;const started=Date.now(),pendingScores=new Map();
  for(let ci=0;ci<video.cards.length;ci++){
   check(stopped);const file=video.cards[ci],bytes=await fs.readFile(file),size=await sharp(bytes).metadata();
   let batch;
   try{batch=await parallelFrames(geometry(r,r.cards[ci],size),this.workerCount,async frame=>{
    check(stopped);const image=await sharp(bytes).extract(frame.rect).png().toBuffer(),pixelHash=S.sha(image);
    let scores=cache.scores[pixelHash];
    if(scores)cacheHits++;
    else if(pendingScores.has(pixelHash)){cacheHits++;scores=await pendingScores.get(pixelHash);}
    else{
     const job=this.infer(image,{stopAt:assets.thresholds.people}).then(value=>{
      if(C.CATALOG.some(c=>!Number.isFinite(value?.[c.id])||value[c.id]<-1||value[c.id]>1))throw fail('The filter returned incomplete frame scores.');
      cache.scores[pixelHash]=value;return value;
     });pendingScores.set(pixelHash,job);
     try{scores=await job;}finally{pendingScores.delete(pixelHash);}
    }
    if(C.CATALOG.some(c=>!Number.isFinite(scores?.[c.id])||scores[c.id]<-1||scores[c.id]>1))throw fail('A cached frame score is invalid. Preserve the cache for diagnosis and prepare the video again.');
    const matches=C.match(scores,cfg,assets.thresholds);if(matches.length)selected++;
    screened++;
    onProgress({id:video.id,screened,total:r.frame_count,selected,skipped:screened-selected,cacheHits,status:'screening',localWorkers:this.workerCount});
    return {...frame,card:r.cards[ci].name,source_path:path.relative(root,file),pixel_hash:pixelHash,scores,matches,selected:matches.length>0};
   },stopped);}finally{await S.atomicJson(cachePath,cache);}
   frames.push(...batch);
  }
  check(stopped);await fs.mkdir(assetDir,{recursive:true});
  const kept=frames.filter(f=>f.selected),sheets=[];
  for(let pos=0;pos<kept.length;){
   check(stopped);let count=Math.min(4,kept.length-pos),packed;
   while(count){packed=await packFrames(root,kept.slice(pos,pos+count));if(packed.data.length<=7_000_000)break;count--;}
   if(!count)throw fail('One selected frame exceeds the 7 MB upload limit. Prepare at a smaller frame width.');
   const name=`card_${String(sheets.length+1).padStart(6,'0')}.jpg`,file=path.join(assetDir,name);
   await fs.writeFile(file+'.tmp',packed.data);await fs.rename(file+'.tmp',file);
   sheets.push({name,path:path.relative(root,file),sha256:S.sha(packed.data),width:packed.width,height:packed.height,frames:packed.mapping});pos+=count;
  }
  check(stopped);
  if(await S.fingerprintCards(video)!==cardSignature||await S.fingerprintVideo(video)!==sourceFingerprint)throw fail('Source changed during screening. Resume to screen the new source.');
  if(artifactDirectory){
   const publishPath=p=>{const relative=path.relative(artifact,path.resolve(root,p));if(relative.startsWith('..')||path.isAbsolute(relative))throw fail('Screening artifact escaped its preparation folder.');return path.relative(root,path.join(published,relative));};
   for(const frame of frames)frame.source_path=publishPath(frame.source_path);
   for(const sheet of sheets){sheet.path=publishPath(sheet.path);for(const frame of sheet.frames)frame.source_path=publishPath(frame.source_path);}
  }
  const manifest={version:1,id:video.id,complete:true,geometry_key:geometryKey(r),source_fingerprint:sourceFingerprint,card_signature:cardSignature,scope:r.scope,segment_start:r.segment_start,segment_end:r.segment_end,config:cfg,filter_key:key,asset_hash:assets.hash,model:assets.manifest,validation:assets.validation,frame_count:frames.length,selected_count:kept.length,frames,sheets};
  manifest.fingerprint=C.hash(manifest);await S.atomicJson(manifestPath,manifest);
  onProgress({id:video.id,screened:frames.length,total:r.frame_count,selected:kept.length,skipped:frames.length-kept.length,cacheHits,status:'ready'});
  return {...manifest,elapsed_ms:Date.now()-started,cache_hits:cacheHits,local_workers:this.workerCount,manifest_path:path.relative(root,manifestPath)};
 }
 async prepareSheet(root,sheet){const bytes=await fs.readFile(path.resolve(root,sheet.path));if(S.sha(bytes)!==sheet.sha256)throw fail('A candidate sheet changed after screening. Resume to rebuild it.');return [{data:bytes.toString('base64'),mime:'image/jpeg',bounds:{x:0,y:0,width:sheet.width,height:sheet.height},imageSize:{width:sheet.width,height:sheet.height},frameMap:sheet.frames}];}
 async close(){await this.pool.close();}
}
async function packFrames(root,frames){
 const cols=Math.min(2,frames.length),rows=Math.ceil(frames.length/cols),cw=frames[0].tileRect.width,ch=frames[0].tileRect.height;
 const width=cols*cw+(cols+1)*4,height=rows*ch+(rows+1)*4;
 const composite=[],mapping=[];let decoded,sourcePath;
 for(let i=0;i<frames.length;i++){const f=frames[i],left=4+(i%cols)*(cw+4),top=4+Math.floor(i/cols)*(ch+4);
  if(sourcePath!==f.source_path){sourcePath=f.source_path;decoded=await sharp(path.resolve(root,sourcePath)).raw().toBuffer({resolveWithObject:true});}
  const {width,height,channels}=decoded.info,input=await sharp(decoded.data,{raw:{width,height,channels}}).extract(f.tileRect).jpeg().toBuffer();
  composite.push({input,left,top});mapping.push({index:f.index,timestamp:f.timestamp,source_path:f.source_path,source_rect:f.rect,bounds:{x:left,y:top,width:cw,height:ch-30}});
 }
 const data=await sharp({create:{width,height,channels:3,background:'#151c23'}}).composite(composite).jpeg({quality:92}).toBuffer();return {data,width,height,mapping};
}
async function verifiedCompletion(root,entry,receipt){
 const p=entry.filter?.manifest_path;if(typeof p!=='string')return false;
 const base=path.resolve(root,'logs','frame-filter'),file=path.resolve(root,p);if(!file.startsWith(base+path.sep))return false;
 const m=await S.readJson(file,null);if(!m)return false;const {fingerprint,...body}=m;
 if(fingerprint!==C.hash(body)||fingerprint!==entry.filter.manifest_fingerprint||!m.complete||m.source_fingerprint!==receipt.source_fingerprint||m.frame_count!==receipt.frame_count||m.frames.length!==receipt.frame_count||m.filter_key!==entry.filter.key)return false;
 if(m.scope!==receipt.scope||m.segment_start!==receipt.segment_start||m.segment_end!==receipt.segment_end)return false;
 if(!m.frames.every((f,i)=>f.index===i&&f.timestamp===(receipt.segment_start||0)+i/receipt.fps&&C.CATALOG.every(c=>Number.isFinite(f.scores?.[c.id])&&f.scores[c.id]>=-1&&f.scores[c.id]<=1)))return false;
 const selected=m.frames.filter(f=>f.selected).map(f=>f.index),mapped=m.sheets.flatMap(s=>s.frames.map(f=>f.index));
 if(JSON.stringify(selected)!==JSON.stringify(mapped)||m.selected_count!==selected.length)return false;
 if(!Array.isArray(entry.filter.reviewed_sheets)||entry.filter.reviewed_sheets.length!==m.sheets.length||!m.sheets.every(s=>entry.filter.reviewed_sheets.includes(s.name)))return false;
 // Durable model results accompany the completion receipt before any asset removal.
 const results=await S.readJson(path.join(path.dirname(file),path.basename(file,'.json')+'.reviews.json'),null);
 if(!results||results.manifest_fingerprint!==fingerprint||!m.sheets.every(s=>results.regions?.[s.name+':0']?.primary && (entry.verification_mode==='none'||results.regions[s.name+':0'].secondary||(entry.verification_mode==='positives'&&results.regions[s.name+':0'].primary.decision==='no'))))return false;
 return true;
}
module.exports={FrameFilter,geometry,verifyReceipt,packFrames,verifiedCompletion,fail};
