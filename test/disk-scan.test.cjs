const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {treeBytes}=require('../lib/pipeline.cjs');
const file=name=>({name,isSymbolicLink:()=>false,isDirectory:()=>false,isFile:()=>true});
const dir=name=>({name,isSymbolicLink:()=>false,isDirectory:()=>true,isFile:()=>false});
const missing=()=>Object.assign(new Error('Removed while scanning'),{code:'ENOENT'});
test('disk scan tolerates prepared.json removed between listing and size lookup',async()=>{
 const root=path.resolve('scan-fixture');
 const io={readdir:async()=>[file('prepared.json'),file('retained.jpg')],lstat:async p=>{if(path.basename(p)==='prepared.json')throw missing();return{size:321,isSymbolicLink:()=>false,isFile:()=>true};}};
 assert.equal(await treeBytes(root,io),321);
});
test('disk scan tolerates whole subfolders removed after the parent was listed',async()=>{
 const root=path.resolve('scan-fixture'),io={readdir:async p=>{if(p!==root)throw missing();return[dir('cleaned-reel')];}};
 assert.equal(await treeBytes(root,io),0);
});
test('disk scan counts hard-linked source bytes only once',async()=>{
 const root=path.resolve('scan-fixture'),stat={size:321,dev:7,ino:42,isSymbolicLink:()=>false,isFile:()=>true};
 const io={readdir:async()=>[file('story-a.mp4'),file('story-b.mp4')],lstat:async()=>stat};
 assert.equal(await treeBytes(root,io),321);
});
test('permission, disk and link failures remain visible during storage accounting',async()=>{
 for(const code of ['EACCES','EPERM','EIO']) {
  await assert.rejects(()=>treeBytes('root',{readdir:async()=>[file('prepared.json')],lstat:async()=>{throw Object.assign(new Error(code),{code});}}),e=>e.code===code);
  await assert.rejects(()=>treeBytes('root',{readdir:async()=>{throw Object.assign(new Error(code),{code});}}),e=>e.code===code);
 }
 await assert.rejects(()=>treeBytes('root',{readdir:async()=>[file('changed-to-link')],lstat:async()=>({isSymbolicLink:()=>true})}),/contains a link/);
});
