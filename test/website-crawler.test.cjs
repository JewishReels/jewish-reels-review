const C=require('../lib/website-crawler.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
test('generic crawler keeps only same-site crawlable links and recognizes playable pages',()=>{assert.deepEqual(C.pageLinks('<a href="/videos/a">a</a><a href="https://elsewhere.test/x">x</a>','https://sample.test/','https://sample.test'),['https://sample.test/videos/a']);assert.equal(C.containsVideo('<video src="a.mp4"></video>','https://sample.test/a'),true);assert.equal(C.containsVideo('<p>text</p>','https://sample.test/a'),false);});
test('MyFootage catalog crawl requires an explicit permission confirmation before any fetch',async()=>{
 await assert.rejects(C.crawl({startUrl:'https://www.myfootage.com/',output:'unused.json'}),error=>error.code==='SOURCE_PERMISSION_REQUIRED');
});
