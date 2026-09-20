function preparationReserve(minimum,load={}){
  const workers=Math.max(0,Math.min(128,Number(load.workers)||0));
  const videos=Math.max(0,Math.min(128,Number(load.videoConcurrency)||0));
  return Math.min(64,Math.max(minimum,Math.ceil(workers/2),videos*2));
}
module.exports={preparationReserve};
