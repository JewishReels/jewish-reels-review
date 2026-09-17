const {test}=require('node:test'),assert=require('node:assert/strict');
const {scorePeopleViews}=require('../lib/people-view-policy.cjs');
test('a passing whole frame skips unnecessary crops without losing its score provenance',async()=>{
 const calls=[];const r=await scorePeopleViews(async i=>{calls.push(i);return .02;},.001);
 assert.deepEqual(calls,[0]);assert.equal(r.people,.02);assert.deepEqual(r._screening,{version:1,views_scored:1,views_total:5,threshold:.001,complete_max:false});
});
test('small people visible only in the last crop are retained; rejections require all views',async()=>{
 for(const last of [.002,-.01]){const calls=[];const r=await scorePeopleViews(async i=>{calls.push(i);return i===4?last:-.05;},.001);assert.equal(calls.length,5);assert.equal(r.people,last);assert.equal(r._screening.complete_max,true);}
});
test('early acceptance has exactly the same decision as exhaustive scoring across all view combinations',async()=>{
 const values=[-.3,.0009,.001,.1];let tested=0;
 for(let n=0;n<4**5;n++){
  const scores=Array.from({length:5},(_,i)=>values[(n>>(2*i))%4]);
  const full=await scorePeopleViews(async i=>scores[i]),fast=await scorePeopleViews(async i=>scores[i],.001);
  assert.equal(fast.people>=.001,full.people>=.001);assert.ok(fast._screening.views_scored<=5);tested++;
 }
 assert.equal(tested,1024);
});
test('invalid or failed view scores never create a negative',async()=>{
 await assert.rejects(()=>scorePeopleViews(async()=>NaN,.001),/Invalid/);
 await assert.rejects(()=>scorePeopleViews(async()=>{throw Error('Model failed');},.001),/Model failed/);
 await assert.rejects(()=>scorePeopleViews(async()=>0,NaN),/threshold/);
});
