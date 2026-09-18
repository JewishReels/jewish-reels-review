const test=require('node:test');
const assert=require('node:assert/strict');
const {resolveMedia}=require('../lib/media.cjs');

test('MyFootage preview page resolves only its matching public watermarked MP4',async()=>{
 const page='https://www.myfootage.com/preview.asp?item=109285',calls=[];
 const html='<script>var Item = {"ItemID":"109285","ImgCaption":"MLK","ImgPreview":"/pix/109/109285-mlk.mp4"}; var Meta = {"MetaItemId":"109285"};</script>';
 const resolved=await resolveMedia(page,undefined,async url=>{calls.push(String(url));return new Response(html,{status:200,headers:{'content-type':'text/html'}});});
 assert.deepEqual(calls,[page]);
 assert.deepEqual(resolved,{provider:'myfootage',url:'https://www.myfootage.com/pix/109/109285-mlk.mp4',referer:page,direct:true,scope:'whole-reel'});
});

test('direct MyFootage preview does not make a page request',async()=>{
 const direct='https://www.myfootage.com/pix/109/109285-mlk.mp4';
 const resolved=await resolveMedia(direct,undefined,async()=>{throw new Error('must not fetch while resolving a direct URL');});
 assert.deepEqual(resolved,{provider:'myfootage',url:direct,referer:'https://www.myfootage.com/preview.asp?item=109285',direct:true,scope:'whole-reel'});
});

test('MyFootage result and home pages are never treated as a playable clip',async()=>{
 assert.deepEqual(await resolveMedia('https://www.myfootage.com/results.asp?x0=1930s'),{url:'https://www.myfootage.com/results.asp?x0=1930s',direct:false,scope:'whole-reel'});
 assert.deepEqual(await resolveMedia('https://www.myfootage.com/'),{url:'https://www.myfootage.com/',direct:false,scope:'whole-reel'});
});
