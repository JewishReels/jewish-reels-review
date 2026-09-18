const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const sharp=require('sharp');
const {HitRecheck}=require('../lib/hit-recheck.cjs');
const Policy=require('../lib/policy.cjs');

const bounds={x:0,y:0,width:32,height:32};
const old=cue=>({card:'card.jpg',region:1,bounds,imageSize:{width:32,height:32},primary:{decision:'hit',cue,evidence:'Old saved positive claim on this image.',location:'center',confidence:.9,box:[.2,.2,.3,.3]}});
const no=model=>({decision:'no',cue:'none',evidence:'No definite allowed visual cue is resolved.',location:'',confidence:.9,box:null,cost:.001,request_id:`${model}-${Math.random()}`,model});
const hit=(model,cue)=>({decision:'hit',cue,evidence:cue==='kippah_religious_setting'?'A clearly resolved round kippah is visible on the person.':'A clearly resolved tallit with visible fringes is present.',location:'center frame',confidence:.92,box:[.2,.2,.3,.3],cost:.001,request_id:`${model}-${Math.random()}`,model});

test('saved-hit report folders sanitize policy versions for Windows paths',()=>{
  const audit=new HitRecheck({reviewer:async()=>{}}),folder=audit.reportDir('C:\\workspace','criteria-1:45c0a7579346ae08');
  assert.equal(path.basename(folder),'hit-recheck-criteria-1-45c0a7579346ae08');
  assert.doesNotMatch(path.basename(folder),/[:*?"<>|]/);
});

test('saved-hit recheck deduplicates pixels, uses one reviewer and leaves the verdict ledger unchanged',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-recheck-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const colors={a:{r:240,g:20,b:20},b:{r:20,g:240,b:20},c:{r:20,g:20,b:240}};
  for(const [id,color] of Object.entries(colors)){const dir=path.join(root,'frames',id,'cards');await fs.mkdir(dir,{recursive:true});await sharp({create:{width:32,height:32,channels:3,background:color}}).jpeg().toFile(path.join(dir,'card.jpg'));}
  await fs.mkdir(path.join(root,'frames','d','cards'),{recursive:true});await fs.copyFile(path.join(root,'frames','a','cards','card.jpg'),path.join(root,'frames','d','cards','card.jpg'));
  const entries=[
    {id:'a',verdict:'jewish',evidence:{...old('judaica'),card_path:'frames/a/cards/card.jpg'}},
    {id:'b',verdict:'jewish',evidence:{...old('tallit_tefillin'),card_path:'frames/b/cards/card.jpg'}},
    {id:'c',verdict:'jewish',evidence:{...old('kippah_religious_setting'),card_path:'frames/c/cards/card.jpg'}},
    {id:'d',verdict:'jewish',copied_from:'a',evidence:{...old('judaica'),card_path:'frames/d/cards/card.jpg'}}
  ];
  const ledger=JSON.stringify(entries);await fs.writeFile(path.join(root,'chat_verdicts.json'),ledger);
  let calls=0,accounted=0;
  const reviewer=async({model,image})=>{calls++;const stats=await sharp(Buffer.from(image.data,'base64')).stats(),d=stats.dominant;if(d.r>d.g&&d.r>d.b)return no(model.id);if(d.g>d.r&&d.g>d.b)return model.id==='primary'?hit(model.id,'tallit_tefillin'):no(model.id);return hit(model.id,'kippah_religious_setting');};
  const terminalBusy=[];const audit=new HitRecheck({reviewer,account:async value=>{accounted+=value.cost||0;}}),policy=Policy.compile();audit.on('state',state=>{if(state.status==='complete')terminalBusy.push(state.busy);});
  const result=await audit.run({root,key:'test',primary:{id:'primary'},policy,workers:2,budget:1});
  assert.equal(result.status,'complete');assert.equal(result.uniqueImages,3);assert.equal(result.completed,3);assert.equal(result.confirmed,2);assert.equal(result.rejectedPrimary,1);assert.equal(result.rejectedUnconfirmed,0);assert.equal(result.errors,0);assert.equal(calls,3);assert.equal(accounted,.003);
  const reportDir=audit.reportDir(root,policy.VERSION),saved=JSON.parse(await fs.readFile(path.join(reportDir,'results.json'),'utf8'));
  assert.equal(saved.source_hit_records,4);assert.equal(saved.source_evidence_rows,4);assert.equal(saved.unique_images,3);assert.equal(saved.secondary_model,null);assert.equal(saved.verification_mode,'single');assert.equal(saved.results.find(value=>value.final==='rejected_by_primary').occurrences.length,2);
  const browser=await audit.results(root,policy);assert.equal(browser.results.length,3);assert.ok(browser.results.every(value=>/^reports[\\/]hit-recheck-/.test(value.image_path)));
  const latest=await audit.results(root,{VERSION:'new-policy-without-a-report'});assert.equal(latest.policy,policy.VERSION);assert.equal(latest.results.length,3);
  const live=JSON.parse(await fs.readFile(path.join(reportDir,'live.json'),'utf8'));assert.equal(live.status,'complete');assert.equal(live.completed,3);
  assert.match(await fs.readFile(path.join(reportDir,'report.html'),'utf8'),/confirmed hit/i);assert.match(await fs.readFile(path.join(reportDir,'report.html'),'utf8'),/re-read once by primary/i);
  assert.equal(await fs.readFile(path.join(root,'chat_verdicts.json'),'utf8'),ledger);
  assert.deepEqual(terminalBusy.slice(-2),[true,false]);assert.equal(audit.snapshot().busy,false);
});

test('saved-hit initialization failure becomes a visible error and releases the run lock',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-recheck-start-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'reports'),'blocked by a file');
  const audit=new HitRecheck({reviewer:async()=>{throw new Error('must not review');}}),policy=Policy.compile();
  await assert.rejects(audit.run({root,key:'test',primary:{id:'primary'},secondary:{id:'secondary'},policy,workers:1,budget:1}));
  assert.equal(audit.running,false);assert.equal(audit.snapshot().status,'error');assert.match(audit.snapshot().message,/ENOTDIR|not a directory/i);
});

test('clearing troubleshooting scores removes only audit reports and leaves the verdict ledger intact',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'reelsight-recheck-clear-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const reports=path.join(root,'reports'),ledger='[{"id":"kept","verdict":"no"}]';
  await fs.mkdir(path.join(reports,'hit-recheck-old','images'),{recursive:true});
  await fs.mkdir(path.join(reports,'hit-recheck-new','images'),{recursive:true});
  await fs.mkdir(path.join(reports,'unrelated-report'),{recursive:true});
  await fs.writeFile(path.join(reports,'hit-recheck-old','results.json'),'{}');
  await fs.writeFile(path.join(reports,'hit-recheck-new','live.json'),'{}');
  await fs.writeFile(path.join(root,'chat_verdicts.json'),ledger);
  const audit=new HitRecheck({reviewer:async()=>{}}),result=await audit.clear(root,Policy.compile());
  assert.equal(result.clearedReports,2);assert.equal(result.status,'idle');assert.equal(result.completed,0);assert.match(result.message,/ready to recheck/i);
  assert.deepEqual(await fs.readdir(reports),['unrelated-report']);assert.equal(await fs.readFile(path.join(root,'chat_verdicts.json'),'utf8'),ledger);
  audit.running=true;await assert.rejects(audit.clear(root,Policy.compile()),/Pause the saved-hit recheck/i);audit.running=false;
});
