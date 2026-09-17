const os=require('node:os');
const path=require('node:path');
const {fork}=require('node:child_process');

function createScreeningWorker(){
 // ONNX's native binding cannot safely share its module state across V8 worker isolates.
 // A separate process also confines a native model crash to the affected frame.
 const child=fork(path.join(__dirname,'frame-filter-worker.cjs'),[],{execPath:process.execPath,execArgv:[],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced',windowsHide:true});
 child.postMessage=message=>child.send(message,error=>{if(error)child.emit('error',error);});
 child.terminate=()=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);child.kill();});
 return child;
}

function screeningCapacity({cpus=os.availableParallelism(),freeBytes=os.freemem()}={}){
 // Leave CPU and memory for decoding, the desktop, and paid review. Model copies are expensive.
 return Math.max(1,Math.min(4,Math.floor(cpus/2),Math.floor(freeBytes/1024**3-2)));
}
class ScreeningPool {
 constructor({modelPath,size=screeningCapacity(),threads=size===1?2:1,createWorker=createScreeningWorker}={}){
  if(!Number.isInteger(size)||size<1||size>4||!Number.isInteger(threads)||threads<1||threads>2)throw new Error('Invalid local screening capacity.');
  this.size=size;this.threads=threads;this.modelPath=modelPath;this.createWorker=createWorker;
  this.slots=Array.from({length:size},()=>({busy:false,worker:null,initialized:false,pending:null}));
  this.queue=[];this.next=0;this.active=0;this.peak=0;this.completed=0;this.initializations=0;this.closed=false;
 }
 stats(){return {workers:this.size,threads_per_worker:this.threads,loaded:this.slots.filter(s=>s.worker).length,active:this.active,peak_active:this.peak,completed:this.completed,initializations:this.initializations,worker_pids:this.slots.map(s=>s.worker?.pid).filter(Boolean),sum_peak_worker_rss_mb:Math.round(this.slots.reduce((n,s)=>n+(s.peakRss||0),0)/1024**2)};}
 run(bytes,options={}){
  if(this.closed)return Promise.reject(new Error('The local screening pool is closed.'));
  return new Promise((resolve,reject)=>{this.queue.push({bytes,options,resolve,reject});this.pump();});
 }
 worker(slot){
  if(slot.worker)return;
  const worker=this.createWorker({workerData:{modelPath:this.modelPath,threads:this.threads}});slot.worker=worker;
  const died=error=>{
   if(slot.worker!==worker)return;
   slot.worker=null;slot.initialized=false;const pending=slot.pending;slot.pending=null;
   pending?.reject(error);void worker.terminate().catch(()=>{});
  };
  worker.on('message',m=>{
   if(slot.worker!==worker||slot.pending?.id!==m.id)return;
   slot.peakRss=Math.max(slot.peakRss||0,m.peakRss||0);
   const p=slot.pending;slot.pending=null;m.error?p.reject(new Error(m.error)):p.resolve(m.value);
  });
  worker.on('error',died);
  worker.on('exit',code=>died(new Error(`The local screening worker stopped (${code}). Resume to retry.`)));
 }
 rpc(slot,method,bytes,options={}){
  if(this.closed)return Promise.reject(new Error('The local screening pool is closed.'));
  this.worker(slot);const id=++this.next;
  return new Promise((resolve,reject)=>{
   slot.pending={id,resolve,reject};
   try{slot.worker.postMessage({id,method,bytes,...options,...(method==='init'?{modelPath:this.modelPath,threads:this.threads}:{})});}catch(e){slot.pending=null;reject(e);}
  });
 }
 pump(){
  if(this.closed)return;
  for(const slot of this.slots){
   if(slot.busy||!this.queue.length)continue;
   const job=this.queue.shift();slot.busy=true;this.active++;this.peak=Math.max(this.peak,this.active);
   (async()=>{
    if(!slot.initialized){await this.rpc(slot,'init');slot.initialized=true;this.initializations++;}
    const value=await this.rpc(slot,'score',job.bytes,job.options);this.completed++;return value;
   })().then(job.resolve,job.reject).finally(()=>{slot.busy=false;this.active--;this.pump();});
  }
 }
 async close(){
  this.closed=true;const error=new Error('The local screening pool is closed.');
  for(const job of this.queue.splice(0))job.reject(error);
  await Promise.all(this.slots.map(async slot=>{
   const worker=slot.worker;slot.worker=null;slot.initialized=false;
   slot.pending?.reject(error);slot.pending=null;if(worker)await worker.terminate();
  }));
 }
}

// Store results in input order, stop scheduling after failure/pause, and drain running work.
async function parallelFrames(items,limit,visit,stopped){
 const results=new Array(items.length);let next=0,error;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!error&&next<items.length){
   try{if(stopped?.())throw Object.assign(new Error('Frame screening paused. Saved scores are retained.'),{filterCancelled:true});
    const i=next++;results[i]=await visit(items[i],i);
   }catch(e){error=error||e;}
  }
 }));
 if(error)throw error;return results;
}
module.exports={ScreeningPool,screeningCapacity,parallelFrames};
