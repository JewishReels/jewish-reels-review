const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { UsageLedger, ReviewClock } = require('../lib/metrics.cjs');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'reelsight-metrics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'logs')); return root;
}
test('historical spend deduplicates response logs, includes billed failures, and recovers orphan responses', async t => {
  const root = await fixture(t), logs = path.join(root, 'logs');
  const response = {request_id:'r1', generation:'g1', cost:.25};
  await fs.writeFile(path.join(logs, 'reelsight_transport.jsonl'), [response,{request_id:'orphan',cost:.5},{request_id:'free429',http_status:429}].map(JSON.stringify).join('\n')+'\n');
  await fs.writeFile(path.join(logs, 'reelsight_reviews.jsonl'), [response,{generation:'g1',cost:.25},{request_id:'invalid',cost:.1,error:'Invalid model result'},{cost:.2,estimated:true},{retry:1}].map(JSON.stringify).join('\n')+'\n{broken\n');
  const usage = await new UsageLedger(root).load();
  assert.ok(Math.abs(usage.total - 1.05) < 1e-9); assert.equal(usage.snapshot().totalEstimated,true); assert.equal(usage.skipped,1);
});
test('64 simultaneous costs persist across restart exactly once and do not mix workspaces', async t => {
  const root = await fixture(t), usage = await new UsageLedger(root).load();
  await Promise.all(Array.from({length:64},(_,i)=>usage.record({request_id:'r'+i,generation:'g'+i,cost:.01,estimated:i===0})));
  await usage.record({request_id:'r1',generation:'g1',cost:.01});
  await usage.record({request_id:'r0',generation:'g0',cost:.02,estimated:false});
  assert.ok(Math.abs(usage.total-.65)<1e-9);assert.equal(usage.snapshot().totalEstimated,false);
  const restored=await new UsageLedger(root).load();assert.ok(Math.abs(restored.total-.65)<1e-9);assert.equal(restored.snapshot().totalEstimated,false);
  assert.equal((await new UsageLedger(await fixture(t)).load()).total,0);
});
test('throughput counts completed IDs and reuse, excludes pause time, and includes active cooldown time', () => {
  let now=0;const clock=new ReviewClock(()=>now);assert.equal(clock.snapshot().videosPerMinute,0);
  clock.setActive(true);now=30000;clock.finish(false);assert.equal(clock.snapshot().videosPerMinute,2);
  clock.setActive(false);now+=300000;assert.equal(clock.snapshot().videosPerMinute,2);
  clock.setActive(true);now+=30000;clock.finish(true);assert.equal(clock.snapshot().videosPerMinute,2);assert.equal(clock.snapshot().sessionReused,1);
  now+=60000;assert.equal(clock.snapshot().videosPerMinute,1);clock.setActive(false);now+=60000;assert.equal(clock.snapshot().processingMs,120000);
});

test('unknown billing is visible after restart and disappears only when that attempt reports a cost',async t=>{
 const root=await fixture(t);await fs.writeFile(path.join(root,'logs/reelsight_transport.jsonl'),[{event:'request_failed',request_id:'lost',billing_uncertain:true},{event:'request_failed',request_id:'connect',billing_uncertain:false},{event:'request_failed',request_id:'legacy'}].map(JSON.stringify).join('\n'));
 const usage=await new UsageLedger(root).load();assert.equal(usage.snapshot().unknownCostAttempts,2);assert.equal(usage.total,0);
 await usage.record({request_id:'lost',generation:'g1',cost:.02});assert.equal(usage.snapshot().unknownCostAttempts,1);assert.equal((await new UsageLedger(root).load()).snapshot().unknownCostAttempts,1);
});
