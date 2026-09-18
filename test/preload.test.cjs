const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

test('preload exposes the preparation snapshot while rejecting unknown actions',async()=>{
 let exposed;const invoked=[];
 const electron={
  contextBridge:{exposeInMainWorld(name,value){assert.equal(name,'reelsight');exposed=value;}},
  ipcRenderer:{async invoke(method,...args){invoked.push({method,args});return{ok:true,value:{status:'buffered'}};},on(){}}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..','preload.cjs'),'utf8'),{require(name){assert.equal(name,'electron');return electron;}},{filename:'preload.cjs'});
 assert.deepEqual(await exposed.call('get-preparation'),{status:'buffered'});
 assert.deepEqual(invoked,[{method:'get-preparation',args:[]}]);
 await assert.rejects(exposed.call('not-a-real-action'),/Unknown action/);
});
