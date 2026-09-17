const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {atomicJson}=require('../lib/storage.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-atomic-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const file=path.join(root,'verdicts.json');await atomicJson(file,{old:true});return{root,file};}
test('temporary Windows file locks retry atomic replacement without exposing partial data',async t=>{
 const {file}=await fixture(t);let attempts=0;const delays=[];
 await atomicJson(file,{saved:true},{rename:async(tmp,dest)=>{attempts++;assert.deepEqual(JSON.parse(await fs.readFile(dest)),{old:true});if(attempts<=3)throw Object.assign(new Error('busy'),{code:['EPERM','EACCES','EBUSY'][attempts-1]});return fs.rename(tmp,dest);},sleep:async ms=>delays.push(ms)});
 assert.deepEqual(delays,[50,100,200]);assert.equal(attempts,4);assert.deepEqual(JSON.parse(await fs.readFile(file)),{saved:true});
});
test('permanent lock and unrelated write failures stop with the original verdict ledger intact',async t=>{
 const {root,file}=await fixture(t);
 for(const code of ['EPERM','EIO']){let attempts=0;await assert.rejects(()=>atomicJson(file,{lost:false},{rename:async()=>{attempts++;throw Object.assign(new Error(code),{code});},sleep:async()=>{}}),new RegExp(code));assert.equal(attempts,code==='EPERM'?7:1);assert.deepEqual(JSON.parse(await fs.readFile(file)),{old:true});assert.deepEqual(await fs.readdir(root),['verdicts.json']);}
});
