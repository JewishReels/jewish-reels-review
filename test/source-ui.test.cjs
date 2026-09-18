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
