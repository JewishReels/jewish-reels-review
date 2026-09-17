const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {ScreeningPool,screeningCapacity,parallelFrames}=require('../lib/screening-pool.cjs');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fakeFactory(){
 const workers=[];
 return {workers,createWorker:()=>{
  const w=new EventEmitter();w.init=0;w.running=0;w.terminated=false;
  w.postMessage=m=>{assert.equal(w.running,0);w.running++;
   setTimeout(()=>{w.running--;if(w.terminated)return;
    if(m.method==='init'){w.init++;w.emit('message',{id:m.id,value:true});}
    else if(m.bytes==='crash')w.emit('exit',0);
    else w.emit('message',{id:m.id,value:{people:m.bytes}});
   },m.bytes===1?30:5);
  };
  w.terminate=async()=>{w.terminated=true;w.emit('exit',1);};workers.push(w);return w;
 }};
}
test('shared screening pool bounds parallelism and initializes each model once',async()=>{
 const f=fakeFactory(),pool=new ScreeningPool({size:3,createWorker:f.createWorker});
 try{const result=await Promise.all(Array.from({length:17},(_,i)=>pool.run(i)));
  assert.deepEqual(result.map(r=>r.people),Array.from({length:17},(_,i)=>i));
  assert.equal(pool.stats().peak_active,3);assert.equal(f.workers.length,3);assert.ok(f.workers.every(w=>w.init===1));
 }finally{await pool.close();}assert.ok(f.workers.every(w=>w.terminated));
});
test('unexpected clean worker exit fails its frame and a later job can retry',async()=>{
 const f=fakeFactory(),pool=new ScreeningPool({size:1,createWorker:f.createWorker});
 try{await assert.rejects(pool.run('crash'),/stopped/);assert.equal((await pool.run(.5)).people,.5);assert.equal(f.workers.length,2);}
 finally{await pool.close();}
});
test('closing rejects active and waiting work without leaving worker requests hanging',async()=>{
 const f=fakeFactory(),pool=new ScreeningPool({size:1,createWorker:f.createWorker});
 const jobs=Promise.allSettled([pool.run(1),pool.run(2),pool.run(3)]);await delay(1);await pool.close();
 assert.ok((await jobs).every(r=>r.status==='rejected'));await assert.rejects(pool.run(4),/closed/);
});
test('parallel frames retain chronological output despite out-of-order completion',async()=>{
 const finished=[];const result=await parallelFrames([0,1,2,3,4],3,async i=>{await delay(i===0?30:1);finished.push(i);return i;});
 assert.deepEqual(result,[0,1,2,3,4]);assert.notEqual(finished[0],0);
});
test('a failed parallel frame drains started frames and never starts remaining work',async()=>{
 const started=[],finished=[];
 await assert.rejects(parallelFrames([0,1,2,3,4,5],3,async i=>{started.push(i);await delay(i===1?1:20);if(i===1)throw new Error('inference failed');finished.push(i);}),/inference failed/);
 assert.deepEqual(started,[0,1,2]);assert.deepEqual(finished,[0,2]);
});
test('pause stops new frame assignments, drains active frames and remains retryable',async()=>{
 let stopped=false;const finished=[];
 await assert.rejects(parallelFrames([0,1,2,3,4,5],2,async i=>{await delay(2);finished.push(i);stopped=true;},()=>stopped),e=>e.filterCancelled);
 assert.deepEqual(finished,[0,1]);
});
test('automatic worker capacity preserves memory and caps CPU parallelism',()=>{
 assert.equal(screeningCapacity({cpus:12,freeBytes:8*1024**3}),4);
 assert.equal(screeningCapacity({cpus:12,freeBytes:4*1024**3}),2);
 assert.equal(screeningCapacity({cpus:2,freeBytes:32*1024**3}),1);
 assert.equal(screeningCapacity({cpus:12,freeBytes:1*1024**3}),1);
});
