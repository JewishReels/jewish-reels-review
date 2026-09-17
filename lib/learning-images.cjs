const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {retryIO}=require('./recovery.cjs');
function makeLearningImages(nativeImage){return async(root,flag)=>{
 const relative=flag.evidence_image||flag.original_verdict?.evidence?.card_path;if(!relative)throw new Error('This correction has no saved evidence image.');
 const base=await fs.realpath(root),source=await retryIO(()=>fs.realpath(path.resolve(base,relative))),rel=path.relative(base,source);
 if(rel.startsWith('..')||path.isAbsolute(rel)||!/\.jpe?g$/i.test(source))throw new Error('Learning evidence must stay inside the selected workspace.');
 if((await fs.stat(source)).size>40000000)throw new Error('Learning image exceeds 40 MB.');
 const bytes=await retryIO(()=>fs.readFile(source)),hash=crypto.createHash('sha256').update(bytes).digest('hex');
 if(flag.evidence_sha256&&hash!==flag.evidence_sha256)throw new Error('Saved false-hit evidence changed. It will not be sent for learning.');
 const sheet=nativeImage.createFromBuffer(bytes);if(sheet.isEmpty())throw new Error('Saved evidence cannot be decoded.');const size=sheet.getSize();if(size.width*size.height>100000000)throw new Error('Learning image exceeds 100 megapixels.');
 const b=flag.original_verdict?.evidence?.bounds||{x:0,y:0,...size};
 if(!['x','y','width','height'].every(k=>Number.isInteger(b[k]))||b.x<0||b.y<0||b.width<=0||b.height<=0||b.x+b.width>size.width||b.y+b.height>size.height)throw new Error('Saved evidence region is invalid; refusing to crop different pixels.');
 const pack=img=>{const s=img.getSize();if(Math.max(s.width,s.height)>2048)img=img.resize(s.width>=s.height?{width:2048}:{height:2048});const data=img.toJPEG(92);if(data.length>7000000)throw new Error('Learning image exceeds 7 MB.');return{data:data.toString('base64'),mime:'image/jpeg',bounds:b,imageSize:size};};
 return{image:pack(sheet.crop(b)),contextImage:(b.width!==size.width||b.height!==size.height)?pack(sheet):undefined,evidence_hash:hash};
};}
module.exports={makeLearningImages};
