const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RequestGate } = require('../lib/request-gate.cjs');

test('single capacity is enforced from startup and progressive throttles honor Retry-After',()=>{
  let now=100000;const gate=new RequestGate({workers:8,now:()=>now});
  assert.equal(gate.limit,1);assert.equal(gate.throttle(),4000);
  gate.throttle();gate.throttle();assert.equal(gate.limit,1);
  now=gate.until;assert.equal(gate.throttle(),8000);assert.equal(gate.limit,1);
  now=gate.until;assert.equal(gate.throttle(),16000);assert.equal(gate.limit,1);
  now=gate.until;assert.equal(gate.throttle(),30000);
  now=gate.until;assert.equal(gate.throttle(900000),900000);
});

test('retry waits and the gap after completion apply while one worker retains its permit',async()=>{
  let now=100000;const gate=new RequestGate({workers:4,now:()=>now,sleep:async ms=>{now+=ms;}});
  gate.throttle(20000);
  const one=await gate.acquire(()=>false);await gate.begin(()=>false);assert.equal(now,120000);assert.equal(gate.active,1);
  now+=5000;gate.finished();one();one();assert.equal(gate.active,0);
  const two=await gate.acquire(()=>false);await gate.begin(()=>false);assert.equal(now,125500);assert.equal(gate.active,1);
  gate.finished();two();assert.equal(gate.active,0);
  const three=await gate.acquire(()=>false);await gate.begin(()=>false);assert.equal(now,126000);three();
});

test('pause interrupts the owner cooldown promptly without dispatch',async()=>{
  let now=100000,stopped=false;const gate=new RequestGate({workers:8,now:()=>now,sleep:async ms=>{now+=ms;stopped=true;}});
  gate.throttle(60000);const release=await gate.acquire(()=>false);assert.equal(await gate.begin(()=>stopped),false);release();assert.equal(gate.active,0);assert.ok(now<=100200);
});

test('FIFO ownership gives waiting workers their turn and drops canceled waiters',async()=>{
 const gate=new RequestGate({workers:4,spacingMs:0,sleep:()=>new Promise(r=>setTimeout(r,1))});
 const first=await gate.acquire(()=>false),order=[];let cancel=false;
 const second=gate.acquire(()=>false).then(release=>{order.push(2);release();});
 const canceled=gate.acquire(()=>cancel);const fourth=gate.acquire(()=>false).then(release=>{order.push(4);release();});
 cancel=true;assert.equal(await canceled,null);assert.deepEqual(order,[]);first();await Promise.all([second,fourth]);assert.deepEqual(order,[2,4]);assert.equal(gate.active,0);assert.equal(gate.queue.length,0);
});

test('concurrent mode grants the selected capacity without a response gap',async()=>{
 const gate=new RequestGate({workers:4,mode:'concurrent',sleep:()=>new Promise(r=>setTimeout(r,1))});
 const releases=await Promise.all(Array.from({length:4},()=>gate.acquire(()=>false)));
 assert.equal(gate.active,4);assert.equal(gate.snapshot().effectiveWorkers,4);assert.equal(gate.snapshot().spacingMs,0);
 let fifthStarted=false;const fifth=gate.acquire(()=>false).then(release=>{fifthStarted=true;release();});
 await new Promise(r=>setTimeout(r,10));assert.equal(fifthStarted,false);
 gate.finished();assert.equal(gate.nextStart,0);releases[0]();await fifth;for(const release of releases)release();assert.equal(gate.active,0);
});

test('an isolated concurrent throttle does not pause healthy sends',async()=>{
 const gate=new RequestGate({workers:4,mode:'concurrent',baseDelayMs:45});
 assert.equal(gate.throttle(80),80);
 const times=await Promise.all(Array.from({length:4},async()=>{const release=await gate.acquire(()=>false);assert.equal(await gate.begin(()=>false),true);const at=Date.now();release();return at;}));
 assert.ok(Math.max(...times)-Math.min(...times)<50);assert.equal(gate.until,0);assert.equal(gate.limit,4);
});

test('128 concurrent permits block the 129th until a request finishes',async()=>{
 const gate=new RequestGate({workers:128,mode:'concurrent',sleep:()=>new Promise(r=>setTimeout(r,1))});
 const releases=await Promise.all(Array.from({length:128},()=>gate.acquire(()=>false)));
 assert.equal(gate.active,128);let extra=false;const next=gate.acquire(()=>false).then(release=>{extra=true;release();});
 await new Promise(r=>setTimeout(r,15));assert.equal(extra,false);releases[0]();await next;
 for(const release of releases)release();assert.equal(gate.active,0);
});

test('an isolated concurrent rate limit delays only that image and retains selected capacity',async()=>{
 let now=100000;const waits=[];
 const gate=new RequestGate({workers:8,mode:'concurrent',now:()=>now,sleep:ms=>new Promise(resolve=>waits.push({ms,resolve}))});
 const owners=await Promise.all(Array.from({length:8},()=>gate.acquire(()=>false)));
 const begun=await Promise.all(Array.from({length:8},()=>gate.begin(()=>false)));
 assert.ok(begun.every(Boolean));assert.equal(gate.inFlight,8);
 assert.equal(gate.throttle(),4000);assert.equal(gate.limit,8);assert.equal(gate.until,0);
 for(let i=0;i<8;i++)gate.finished();
 const retries=Array.from({length:8},()=>gate.begin(()=>false));
 await Promise.all(retries);
 assert.equal(gate.inFlight,8);assert.equal(waits.length,0);
 for(let i=0;i<8;i++)gate.finished({success:true});
 assert.equal(gate.limit,8);
 for(const release of owners)release();
});

test('sixteen clean responses reset an old rate-limit incident',()=>{
 let now=100000;const gate=new RequestGate({workers:32,now:()=>now});
 gate.inFlight=32;assert.equal(gate.throttle(),4000);gate.inFlight=0;now=gate.until;
 gate.inFlight=16;assert.equal(gate.throttle(),8000);gate.inFlight=0;now=gate.until;
 for(let i=0;i<16;i++)gate.finished({success:true});
 assert.equal(gate.waves,0);
 gate.inFlight=1;assert.equal(gate.throttle(),4000);
});
