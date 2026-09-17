import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),C=require('../lib/frame-filter-config.cjs'),P=require('../lib/people-scoring.cjs');
const root=path.resolve(import.meta.dirname,'../../package-resources/frame-filter');
const source=path.resolve(import.meta.dirname,'../../model-build');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function download(name){
 const file=path.join(source,name);
 try{await fs.access(file);return;}catch{}
 const response=await fetch('https://huggingface.co/'+C.MODEL+'/resolve/'+C.MODEL_REVISION+'/'+name);
 if(!response.ok)throw Error(name+': '+response.status);
 await fs.mkdir(path.dirname(file),{recursive:true});
 const h=await fs.open(file+'.part','w');try{for await(const chunk of response.body)await h.write(chunk);}finally{await h.close();}
 await fs.rename(file+'.part',file);
}
for(const name of ['config.json','preprocessor_config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/text_model_quantized.onnx','onnx/vision_model_quantized.onnx'])await download(name);
const revision=JSON.parse(await fs.readFile(path.join(source,'revision.json')).catch(()=>Buffer.from(JSON.stringify({revision:C.MODEL_REVISION}))));
if(revision.revision!==C.MODEL_REVISION)throw Error('Wrong cached model revision; use a clean model-build directory.');
if(sha(await fs.readFile(path.join(source,'onnx/vision_model_quantized.onnx')))!==C.VISION_SHA256)throw Error('Wrong vision encoder hash.');
const {env,AutoTokenizer,SiglipTextModel}=await import('@huggingface/transformers');env.allowRemoteModels=false;
const tokenizer=await AutoTokenizer.from_pretrained(source),model=await SiglipTextModel.from_pretrained(source,{dtype:'q8',device:'cpu',session_options:{intraOpNumThreads:2}}),vectors=[];
try{
 for(const [group,prompts]of [['positive',C.CATALOG[0].prompts],['negative',C.CATALOG[0].negativePrompts]])for(const prompt of prompts){
  const output=await model(await tokenizer(prompt,{padding:'max_length',max_length:64,truncation:true}));
  const v=Array.from((output.text_embeds||output.pooler_output).data),n=Math.hypot(...v);vectors.push({group,prompt,values:v.map(x=>x/n)});
 }
}finally{await model.dispose();}
const embeddings={version:1,catalog_hash:C.CATALOG_HASH,scoring:P.SCORING_VERSION,vectors};P.validateEmbeddings(embeddings);
const bytes=Buffer.from(JSON.stringify(embeddings));
const thresholds=JSON.parse(await fs.readFile(path.join(root,'thresholds.json')));
if(thresholds.embeddings_sha256!==sha(bytes)||thresholds.method!==P.SCORING_VERSION)throw Error('Generated embeddings do not match the frozen people calibration. Do not package uncalibrated assets.');
await fs.writeFile(path.join(root,'embeddings.json'),bytes);
for(const name of ['config.json','preprocessor_config.json','onnx/vision_model_quantized.onnx']){await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.copyFile(path.join(source,name),path.join(root,name));}
const files={};for(const name of ['config.json','preprocessor_config.json','onnx/vision_model_quantized.onnx','embeddings.json','thresholds.json'])files[name]=sha(await fs.readFile(path.join(root,name)));
await fs.writeFile(path.join(root,'manifest.json'),JSON.stringify({version:1,model:C.MODEL,revision:C.MODEL_REVISION,preprocessing:C.PREPROCESSING,catalog_hash:C.CATALOG_HASH,files},null,2));
await new (require('../lib/frame-filter.cjs').FrameFilter)({modelPath:root}).ready();
console.log('Verified people-only model ready at '+root);
