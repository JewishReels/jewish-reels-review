const {test}=require('node:test'),assert=require('node:assert/strict');
const {reviewImage}=require('../lib/openrouter.cjs');
const model={id:'test/vision',architecture:{input_modalities:['image'],output_modalities:['text']},supported:[],pricing:{}};
const image={data:Buffer.from('synthetic pixels').toString('base64'),mime:'image/png'};
test('transport diagnostics pair a request with sanitized upstream details and no image payload',async t=>{
  const before=global.fetch;t.after(()=>global.fetch=before);const events=[];
  global.fetch=async()=>({ok:false,status:429,headers:new Headers({'retry-after':'30'}),json:async()=>({error:{code:429,message:'Provider returned error',metadata:{provider_name:'Example',error_type:'rate_limit_exceeded',raw:JSON.stringify({code:'Capacity',message:'Retry sk-or-private-key',request:{authorization:'NEVER_LOG_THIS'}})}}})});
  await assert.rejects(()=>reviewImage({key:'sk-or-private-key',model,image,onDiagnostic:async r=>events.push(r)}),e=>e.status===429&&e.providerDetail.includes('Capacity'));
  assert.equal(events.length,2);assert.equal(events[0].request_id,events[1].request_id);assert.match(events[0].image.sha256,/^[a-f0-9]{64}$/);assert.equal(events[1].error.error_type,'rate_limit_exceeded');assert.equal(events[1].retry_after,'30');
  const text=JSON.stringify(events);for(const secret of ['sk-or-private-key','NEVER_LOG_THIS',image.data])assert.ok(!text.includes(secret));
});
test('transport logs network failures and refuses to send when the request log cannot be saved',async t=>{
  const before=global.fetch;t.after(()=>global.fetch=before);const events=[];let calls=0;
  global.fetch=async()=>{calls++;throw new Error('Network timeout');};
  await assert.rejects(()=>reviewImage({key:'MOCK',model,image,onDiagnostic:async r=>events.push(r)}),/Network timeout/);
  assert.equal(events[1].event,'request_failed');assert.equal(events[0].request_id,events[1].request_id);
  await assert.rejects(()=>reviewImage({key:'MOCK',model,image,onDiagnostic:async()=>{throw new Error('Disk full');}}),/Disk full/);assert.equal(calls,1);
});

test('fetch errors retain sanitized nested causes and identify connect timeouts before billing',async t=>{
 const old=global.fetch;t.after(()=>global.fetch=old);const events=[];
 global.fetch=async()=>{throw new TypeError('fetch failed',{cause:Object.assign(new Error('Connect timed out sk-or-private-key'),{code:'UND_ERR_CONNECT_TIMEOUT'})});};
 await assert.rejects(()=>reviewImage({key:'MOCK',model,image,onDiagnostic:async r=>events.push(r)}),e=>e.transient&&e.code==='TRANSIENT_NETWORK'&&!e.billingUncertain&&e.message.includes('UND_ERR_CONNECT_TIMEOUT'));
 assert.equal(events[1].network.causes[1].code,'UND_ERR_CONNECT_TIMEOUT');assert.equal(events[1].retryable,true);assert.equal(events[1].billing_uncertain,false);assert.ok(!JSON.stringify(events).includes('sk-or-private-key'));
});

test('certificate failures and explicit cancellation are not retried',()=>{
 const {connectionError}=require('../lib/network.cjs');
 assert.equal(connectionError(new TypeError('fetch failed',{cause:Object.assign(new Error('Certificate rejected'),{code:'CERT_HAS_EXPIRED'})})).transient,false);
 assert.equal(connectionError(Object.assign(new Error('Canceled'),{name:'AbortError'})).transient,false);
 assert.equal(connectionError(new TypeError('fetch failed')).billingUncertain,true);
});

test('a lost response body preserves HTTP status, socket error, and unknown billing',async t=>{
 const old=global.fetch;t.after(()=>global.fetch=old);const events=[];
 global.fetch=async()=>({status:200,json:async()=>{throw new TypeError('terminated',{cause:Object.assign(new Error('other side closed'),{code:'UND_ERR_SOCKET'})});}});
 await assert.rejects(()=>reviewImage({key:'MOCK',model,image,onDiagnostic:async r=>events.push(r)}),e=>e.transient&&e.billingUncertain&&e.network.phase==='response-body');
 assert.equal(events[1].http_status,200);assert.equal(events[1].network.causes[1].code,'UND_ERR_SOCKET');
});
