const fs=require('node:fs/promises'),path=require('node:path');
const {validateEmbeddings,peopleViewScore}=require('./people-scoring.cjs');
const {scorePeopleViews}=require('./people-view-policy.cjs');
let model,processor,RawImage,vectors;
const normalize=v=>{const a=Array.from(v),n=Math.hypot(...a);if(!Number.isFinite(n)||!n)throw new Error('Empty model embedding.');return a.map(x=>x/n);};
async function init(workerData){
 const T=await import('@huggingface/transformers');T.env.allowRemoteModels=false;RawImage=T.RawImage;
 vectors=validateEmbeddings(JSON.parse(await fs.readFile(path.join(workerData.modelPath,'embeddings.json'))));
 processor=await T.AutoProcessor.from_pretrained(workerData.modelPath);
 model=await T.SiglipVisionModel.from_pretrained(workerData.modelPath,{dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:workerData.threads||2,interOpNumThreads:1}});
 return true;
}
async function score(bytes,stopAt){
 const sharp=require('sharp'),{data,info}=await sharp(Buffer.from(bytes)).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const full=new RawImage(new Uint8ClampedArray(data),info.width,info.height,info.channels);
 const w=Math.max(1,Math.round(info.width*.6)),h=Math.max(1,Math.round(info.height*.6));
 return scorePeopleViews(async i=>{
  const x=(i-1)%2?info.width-w:0,y=i>2?info.height-h:0;
  const view=i===0?full:await full.crop([x,y,x+w-1,y+h-1]);
  const output=await model(await processor(view)),vector=normalize((output.image_embeds||output.pooler_output).data);
  return peopleViewScore(vector,vectors);
 },stopAt);
}
let chain=Promise.resolve();
let peakRss=0;setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);},100).unref();
process.on('disconnect',()=>process.exit(0));
process.on('message',message=>{chain=chain.then(async()=>{try{const value=message.method==='init'?await init(message):await score(message.bytes,message.stopAt);process.send?.({id:message.id,value,peakRss});}catch(e){process.send?.({id:message.id,error:e.message,peakRss});}});});
