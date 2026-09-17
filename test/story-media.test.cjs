const {test}=require('node:test'),assert=require('node:assert/strict');
const {resolveMedia,contactSheetGeometry,samplingPlan,coverageRange}=require('../lib/media.cjs');
test('Hungarian item uses explicit player boundaries and never silently expands to a reel',async t=>{
 const before=global.fetch;t.after(()=>global.fetch=before);
 global.fetch=async()=>({ok:true,text:async()=>'<source src="/reel.mp4"><script>var start = 497; var end = 551;</script>'});
 const r=await resolveMedia('https://filmhiradokonline.hu/watch.php?id=196');assert.equal(r.scope,'segment');assert.equal(r.segment_start,497);assert.equal(r.segment_end,551);
 for(const script of ['', 'var start=497;', 'var start=497; var end=490;']){
  global.fetch=async()=>({ok:true,text:async()=>'<source src="/reel.mp4">'+script});await assert.rejects(()=>resolveMedia('https://filmhiradokonline.hu/watch.php?id=196'),/valid start\/end/);
 }
});
test('contact-sheet geometry remains even for anamorphic sources with an odd display width',()=>{
 assert.deepEqual(contactSheetGeometry({width:352,height:288,sample_aspect_ratio:375/352},1280),{actualWidth:374,height:288});
 assert.deepEqual(contactSheetGeometry({width:1920,height:1080,sample_aspect_ratio:1},960),{actualWidth:960,height:540});
});
test('adaptive sampling keeps a rolling one-second gap and admits only changed subsecond candidates',()=>{
 const fixed=samplingPlan(1),adaptive=samplingPlan(4);
 assert.equal(fixed.adaptive,false);assert.equal(fixed.maxFps,1);
 assert.equal(adaptive.adaptive,true);assert.equal(adaptive.baseFps,1);assert.equal(adaptive.maxFps,4);
 assert.match(adaptive.filter,/fps=fps=4/);
 assert.match(adaptive.filter,/gte\(t-prev_selected_t,1\)/);
 assert.match(adaptive.filter,/gt\(scene,0\.05\)/);
 assert.throws(()=>samplingPlan(8),/Unsupported sampling rate/);
});
test('fractional source duration accepts the final decoded second without inventing an extra frame',()=>{
 assert.deepEqual(coverageRange(480.04,1),{minimum:480,maximum:481});
 assert.deepEqual(coverageRange(40.96,1),{minimum:40,maximum:41});
 assert.deepEqual(coverageRange(.4,1),{minimum:1,maximum:1});
 assert.deepEqual(coverageRange(10.25,4),{minimum:10,maximum:41});
});
