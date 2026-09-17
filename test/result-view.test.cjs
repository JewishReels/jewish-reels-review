const {test}=require('node:test');
const assert=require('node:assert/strict');
const V=require('../lib/result-view.cjs');

const hit={id:'fho-1',verdict:'jewish',title:'A title',cues:['judaica'],summary:'Visible ritual object.',confidence:.9,cards_reviewed:['a.jpg','b.jpg'],evidence:{card_path:'frames/fho-1/cards/a.jpg',primary:{evidence:'x'.repeat(5000)}}};
const no={id:'fho-2',verdict:'filtered_no',title:'Another title',summary:'A very long negative explanation that the dashboard does not need.',cards_reviewed:Array.from({length:200},(_,i)=>`card_${i}.jpg`),filter:{scores:Array(1000).fill(.1)}};

test('result summaries retain navigation fields and omit nested evidence and coverage arrays',()=>{
 const values=V.summaries([hit,no],{version:1,events:[]});
 assert.deepEqual(values[0].cues,['judaica']);assert.equal(values[0].evidence_available,true);assert.equal(values[0].cards_reviewed_count,2);
 assert.equal(values[0].evidence,undefined);assert.equal(values[0].cards_reviewed,undefined);
 assert.equal(values[1].summary,undefined);assert.equal(values[1].filter,undefined);assert.equal(values[1].cards_reviewed_count,200);
 assert.ok(JSON.stringify(values).length<JSON.stringify([hit,no]).length/10);
});

test('one result detail is annotated on demand without returning every verdict',()=>{
 const found=V.detail([hit,no],{version:1,events:[]},'fho-1');
 assert.equal(found.id,'fho-1');assert.equal(found.evidence.primary.evidence.length,5000);assert.match(found.feedback_target,/^[a-f0-9]{64}$/);
 assert.equal(V.detail([hit,no],{version:1,events:[]},'missing'),null);
});

test('summaries expose a compact per-video evidence hit count',()=>{
 const multi={...hit,evidence_hits:[hit.evidence,{...hit.evidence,card_path:'frames/fho-1/cards/b.jpg'}]};
 const value=V.summaries([multi],{version:1,events:[]})[0];
 assert.equal(value.evidence_hit_count,2);assert.equal(value.evidence_hits,undefined);assert.equal(value.evidence_available,true);
});

test('copied hit chains appear once while retaining every catalog id',()=>{
 const original={...hit,source_fingerprint:'same-source',evidence:{card:'card_17.jpg',card_path:'frames/original/cards/card_17.jpg',primary:{request_id:'one',decision:'hit'}}};
 const first={...original,id:'copy-1',copied_from:original.id},second={...original,id:'copy-2',copied_from:first.id};
 const values=V.summaries([original,first,second,no],{version:1,events:[]});
 assert.equal(values.filter(v=>v.verdict==='jewish').length,1);
 assert.deepEqual(values[0].catalog_ids,['fho-1','copy-1','copy-2']);assert.equal(values[0].catalog_id_count,3);
 assert.equal(values.filter(v=>v.verdict==='filtered_no').length,1);
});
