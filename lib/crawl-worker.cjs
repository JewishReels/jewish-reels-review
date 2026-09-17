const {parentPort,workerData}=require('node:worker_threads');const C=require('./website-crawler.cjs');
C.crawl({...workerData,onProgress:p=>parentPort.postMessage({type:'progress',value:p})}).then(value=>parentPort.postMessage({type:'done',value})).catch(error=>parentPort.postMessage({type:'error',error:error.message,stack:error.stack}));
