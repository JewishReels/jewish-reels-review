const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('MyFootage source registration is separate from its permission-gated crawl action',()=>{
 const html=fs.readFileSync(path.join(__dirname,'..','ui','index.html'),'utf8'),app=fs.readFileSync(path.join(__dirname,'..','ui','app.js'),'utf8');
 assert.match(html,/value="myfootage">MyFootage</);
 assert.match(html,/id="addWebsiteSource"/);
 assert.match(html,/id="crawlPermission"/);
 assert.match(html,/I confirm that I have permission from the website owner/);
 assert.match(app,/api\.call\('add-website-source',\{url:/);
 assert.match(app,/api\.call\('crawl-website',\{url:[^}]+authorized:/);
 assert.match(app,/added as an empty source\. No website request was made\./);
});

test('saved-hit views use the workspace-wide hit collection while active review stays source-scoped',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','ui','app.js'),'utf8'),bulk=fs.readFileSync(path.join(__dirname,'..','ui','bulk-feedback.js'),'utf8'),main=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8'),storage=fs.readFileSync(path.join(__dirname,'..','lib','storage.cjs'),'utf8'),html=fs.readFileSync(path.join(__dirname,'..','ui','index.html'),'utf8');
 assert.match(storage,/workspaceHits:\s*current\.filter\(entry => entry\.verdict === 'jewish'\)/);
 assert.match(main,/entries:\s*V\.summaries\(p\.entries, feedback\)/);
 assert.match(main,/hitEntries:\s*V\.summaries\(p\.workspaceHits/);
 assert.doesNotMatch(main,/selectedProject\s*=\s*\{\s*\.\.\.selectedProject,\s*entries:\s*ledger\.entries/);
 assert.match(app,/acceptedMatches=\(\)=>hitEntries\.filter\(isAcceptedHit\)/);
 assert.match(app,/mergeResult\(entries,entry\);mergeResult\(hitEntries,entry,true\)/);
 assert.match(bulk,/for \(const entry of hitEntries\.slice\(\)\.reverse\(\)\)/);
 assert.match(html,/ALL SOURCES/);
});

test('Scrapfly access can be entered and saved in every preparation state',()=>{
 const app=fs.readFileSync(path.join(__dirname,'..','ui','app.js'),'utf8'),main=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8');
 assert.match(app,/\['scrapflyApiKey','rememberScrapflyKey'\]\)\$\(id\)\.disabled=false/);
 assert.match(app,/saveScrapflyKey'\)\.disabled=false/);
 assert.doesNotMatch(main,/pipeline\.running&&pipeline\.state\.status!=='buffered'/);
 assert.match(main,/if\(pipeline\.running\)pipeline\.notifyWork\(\);else if\(!crawlWorker\)ensureBackfill\(\)/);
 assert.match(main,/safeStorage\.isEncryptionAvailable\(\).*scrapflySecret=normalized/s);
});
test('renderer preload exposes the preparation refresh used after reopening a workspace',()=>{
 const preload=fs.readFileSync(path.join(__dirname,'..','preload.cjs'),'utf8');assert.match(preload,/['"]get-preparation['"]/);
});
test('active review errors stay source-scoped while storage keeps every manual hold protected',()=>{
 const main=fs.readFileSync(path.join(__dirname,'..','main.cjs'),'utf8'),engine=fs.readFileSync(path.join(__dirname,'..','lib','engine.cjs'),'utf8');
 assert.match(engine,/emit\('deferred-workspace', videos\)/);assert.match(main,/engine\.on\('deferred-workspace', items => pipeline\.setDeferredItems\(items\)\)/);assert.doesNotMatch(main,/pipeline\.setDeferredItems\(s\.deferred\)/);
});
