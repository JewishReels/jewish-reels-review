const {test}=require('node:test'),assert=require('node:assert/strict');
const {preparationReserve}=require('../lib/preparation-reserve.cjs');
const {admissionReserveBytes}=require('../lib/pipeline.cjs');
test('64 request workers maintain 32 clips ahead in addition to active reviews',()=>{
 assert.equal(preparationReserve(3,{workers:64,videoConcurrency:16}),32);
 assert.equal(preparationReserve(10,{workers:64,videoConcurrency:8}),32);
 assert.equal(preparationReserve(64,{workers:64,videoConcurrency:16}),64);
});
test('128 request workers maintain 64 clips ahead without exceeding the queue cap',()=>{
 assert.equal(preparationReserve(3,{workers:128,videoConcurrency:16}),64);
});
test('the reserve follows configured concurrency and preserves larger user minimums',()=>{
 assert.equal(preparationReserve(3),3);assert.equal(preparationReserve(10,{workers:4,videoConcurrency:4}),10);
 assert.equal(preparationReserve(3,{workers:4,videoConcurrency:4}),8);
 assert.equal(preparationReserve(3,{workers:1000,videoConcurrency:1000}),64);
});
test('storage admission reserves 256 MiB per active preparation plus publication',()=>{
 assert.equal(admissionReserveBytes(1),512*1024*1024);
 assert.equal(admissionReserveBytes(8),9*256*1024*1024);
 assert.equal(admissionReserveBytes(128),9*256*1024*1024);
});
