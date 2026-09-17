const C=require('./frame-filter-config.cjs');
const SCORING_VERSION='people-positive-negative-margin-v1';
function validateEmbeddings(asset){
 if(!asset||asset.version!==1||asset.catalog_hash!==C.CATALOG_HASH||asset.scoring!==SCORING_VERSION||!Array.isArray(asset.vectors))throw new Error('Missing or incompatible people embeddings.');
 const expected=[...C.CATALOG[0].prompts.map(prompt=>({group:'positive',prompt})),...C.CATALOG[0].negativePrompts.map(prompt=>({group:'negative',prompt}))];
 if(asset.vectors.length!==expected.length)throw new Error('Incomplete people embeddings.');
 for(let i=0;i<expected.length;i++){
  const v=asset.vectors[i],e=expected[i];
  if(v.group!==e.group||v.prompt!==e.prompt||!Array.isArray(v.values)||v.values.length!==768||v.values.some(x=>!Number.isFinite(x))||Math.abs(Math.hypot(...v.values)-1)>.001)throw new Error('Invalid people text embedding.');
 }
 return asset.vectors;
}
function peopleViewScore(vector,vectors){
 if(vector.length!==768||Array.from(vector).some(x=>!Number.isFinite(x)))throw new Error('Incompatible image embedding.');
 let positive=-1,negative=-1;
 for(const text of vectors){
  let score=0;for(let i=0;i<vector.length;i++)score+=vector[i]*text.values[i];
  if(text.group==='positive')positive=Math.max(positive,score);else negative=Math.max(negative,score);
 }
 // An independent margin, not a probability or a forced winning category.
 return Math.max(-1,Math.min(1,(positive-negative)/2));
}
module.exports={SCORING_VERSION,validateEmbeddings,peopleViewScore};
