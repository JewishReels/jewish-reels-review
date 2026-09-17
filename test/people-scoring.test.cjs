const {test}=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/frame-filter-config.cjs'),P=require('../lib/people-scoring.cjs');
const vector=(a,b)=>[a,b,...Array(766).fill(0)];
function fixture(){return {version:1,catalog_hash:C.CATALOG_HASH,scoring:P.SCORING_VERSION,vectors:[...C.CATALOG[0].prompts.map(prompt=>({group:'positive',prompt,values:vector(1,0)})),...C.CATALOG[0].negativePrompts.map(prompt=>({group:'negative',prompt,values:vector(0,1)}))]};}
test('People is the only local choice; archival cues remain AI classification rules',()=>{
 assert.deepEqual(C.CATALOG.map(c=>c.id),['people']);
 const policy=require('../lib/policy.cjs');assert.ok(policy.CUES.includes('orthodox_beard_hat'));assert.ok(policy.CUES.includes('judaica'));
 assert.deepEqual(C.normalize(),{version:2,enabled:false,cues:['people']});
 assert.throws(()=>C.normalize({version:2,enabled:true,cues:['orthodox_beard_hat']}),/checklist/);
});
test('legacy enabled cue preferences migrate to people without a beard method or old scores',()=>{
 const cfg=C.normalize({version:1,enabled:true,cues:['orthodox_beard_hat'],beardMode:'heads'});
 assert.deepEqual(cfg,{version:2,enabled:true,cues:['people']});
 assert.deepEqual(C.match({orthodox_beard_hat:1},cfg,{people:0}),[]);
 assert.equal(C.normalize({version:1,enabled:false,cues:['judaica']}).enabled,false);
 assert.throws(()=>C.normalize({version:1,enabled:true,cues:['unknown']}),/checklist/);
 assert.throws(()=>C.normalize({version:3}),/version/);
 assert.throws(()=>C.normalize({enabled:true,cues:[]}),/at least one/);
});
test('person margin rejects an empty scene even with high positive cosine similarity',()=>{
 const vectors=P.validateEmbeddings(fixture());
 const yes=P.peopleViewScore(vector(.8,.6),vectors),no=P.peopleViewScore(vector(.6,.8),vectors);
 assert.ok(yes>0);assert.ok(no<0);
 assert.deepEqual(C.match({people:no},{enabled:true,cues:['people']},{people:0}),[]);
 assert.deepEqual(C.match({people:yes},{enabled:true,cues:['people']},{people:0}),['people']);
});
test('one matching detail view qualifies the frame without requiring a face or head attributes',()=>{
 const vectors=P.validateEmbeddings(fixture()),score=rows=>Math.max(...rows.map(row=>P.peopleViewScore(vector(...row),vectors)));
 assert.ok(score([[0,1],[0,1],[.8,.6],[0,1],[0,1]])>0);
 assert.ok(score([[0,1],[0,1],[.6,.8],[0,1],[0,1]])<0);
});
test('corrupt and mismatched text embeddings are fatal rather than selecting every frame',()=>{
 assert.throws(()=>P.validateEmbeddings(null),/incompatible/);
 for(const mutate of [a=>a.vectors.pop(),a=>a.vectors[0].values.pop(),a=>a.vectors[0].values[0]=NaN,a=>a.vectors[0].group='negative',a=>a.catalog_hash='old']){
  const a=fixture();mutate(a);assert.throws(()=>P.validateEmbeddings(a),/Incomplete|Invalid|incompatible/);
 }
 assert.throws(()=>P.peopleViewScore([1],fixture().vectors),/Incompatible/);
});
test('filter enablement and asset version change checkpoint identities',()=>{
 const a={enabled:true,cues:['people']};
 assert.notEqual(C.fingerprint(a,'v1'),C.fingerprint(a,'v2'));
 assert.notEqual(C.fingerprint(a,'v1'),C.fingerprint({...a,enabled:false},'v1'));
 assert.equal(C.fingerprint(a,'v1'),C.fingerprint({...a,version:2},'v1'));
});
