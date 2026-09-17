const path=require('node:path'),{randomUUID}=require('node:crypto'),S=require('./storage.cjs'),C=require('./learning-contract.cjs'),R=require('./rule-similarity.cjs');
const queues=new Map();const filename=root=>path.join(root,'feedback','learning.json');
async function load(root) {
 const value=await S.readJson(filename(root),{version:1,lessons:[],actions:[]});
 if(value?.version!==1 || !Array.isArray(value.lessons)||!Array.isArray(value.actions) || value.lessons.some(x=>!x?.id||!x.feedback_id||!x.target_key||!['ready','failed','blocked','missing','uncertain_cost'].includes(x.status)||x.feedback_action!=null&&!['false_hit','confirmed_hit'].includes(x.feedback_action)) || value.actions.some(x=>!x?.lesson_id||!['apply','disable'].includes(x.action)))throw new Error('The learning journal is invalid. It has been preserved for diagnosis.');
 for(const lesson of value.lessons)if(lesson.status==='ready')C.validateStored(lesson.analysis);
 return value;
}
async function update(root,fn){const key=path.resolve(root),p=(queues.get(key)||Promise.resolve()).catch(()=>{}).then(async()=>{const doc=await load(root);await fn(doc);await S.atomicJson(filename(root),doc);return doc;});queues.set(key,p);try{return await p;}finally{if(queues.get(key)===p)queues.delete(key);}}
function validTargets(feedback){return new Map(feedback.map(f=>[f.event_id,f]));}
function supported(lesson,flag){
 const action=lesson.feedback_action||flag?.action;
 return action==='false_hit'&&lesson.analysis?.assessment==='false_positive' || action==='confirmed_hit'&&lesson.analysis?.assessment==='confirmed_hit';
}
function enabled(doc,feedback){
 const targets=validTargets(feedback),actions=new Map(doc.actions.map(a=>[a.lesson_id,a.action])),latest=new Map();
 for(const lesson of doc.lessons){
  const flag=targets.get(lesson.feedback_id);
  if(lesson.status!=='ready'||!flag||flag.target_key!==lesson.target_key||!supported(lesson,flag))continue;
  // Existing version-1 lessons retain their previous Apply/Disable setting.
  // Version-2 retraining lessons are applied automatically.
  if(!lesson.feedback_action&&actions.get(lesson.id)!=='apply')continue;
  C.validateStored(lesson.analysis);latest.set(lesson.feedback_id,lesson);
 }
 return [...latest.values()];
}
function similarLessons(left,right){
 const leftAction=left.feedback_action,leftAnalysis=left.analysis,rightAction=right.feedback_action,rightAnalysis=right.analysis;
 if(leftAction!==rightAction||leftAnalysis.cue!==rightAnalysis.cue)return false;
 if(R.canonical(leftAnalysis.check)===R.canonical(rightAnalysis.check))return true;
 const check=R.overlap(leftAnalysis.check,rightAnalysis.check);if(check<.64)return false;
 return check>=.78||R.overlap(leftAnalysis.preserve_true_hits,rightAnalysis.preserve_true_hits)>=.42;
}
function consolidateEnabled(lessons,feedback){
 const targets=validTargets(feedback),prepared=lessons.map(lesson=>({...lesson,feedback_action:lesson.feedback_action||targets.get(lesson.feedback_id)?.action})),groups=[];
 for(const lesson of prepared){let group=groups.find(candidate=>candidate.some(member=>similarLessons(member,lesson)));if(group)group.push(lesson);else groups.push([lesson]);}
 return groups.map(group=>{
  let representative=group[0],best=-1;
  for(const candidate of group){const score=group.reduce((sum,member)=>sum+R.overlap(candidate.analysis.check,member.analysis.check),0);if(score>best||score===best&&candidate.analysis.check.length<representative.analysis.check.length){representative=candidate;best=score;}}
  return {...representative,feedback_ids:group.map(item=>item.feedback_id).sort(),merged_lesson_ids:group.map(item=>item.id),support_count:group.length};
 });
}
function consolidated(doc,feedback){return consolidateEnabled(enabled(doc,feedback),feedback);}
function view(doc,feedback){
 const current=enabled(doc,feedback),active=new Set(current.map(l=>l.id)),targets=validTargets(feedback),membership=new Map();
 for(const group of consolidateEnabled(current,feedback))for(const id of group.merged_lesson_ids)membership.set(id,group.support_count);
 return doc.lessons.slice().reverse().map(l=>({...l,active:active.has(l.id),stale:targets.get(l.feedback_id)?.target_key!==l.target_key,merged_count:membership.get(l.id)||0}));
}
async function add(root,lesson){const entry={id:randomUUID(),created_at:new Date().toISOString(),...lesson};if(entry.status==='ready')C.validateStored(entry.analysis);await update(root,doc=>{doc.lessons.push(entry);});return entry;}
async function setActive(root,id,apply,getFeedback){return update(root,async doc=>{const feedback=await getFeedback(),lesson=doc.lessons.find(l=>l.id===id);if(!lesson)throw new Error('This saved lesson is unavailable.');if(lesson.feedback_action)throw new Error('Rules created by full-feedback retraining are applied automatically. Retrain to replace them.');if(apply){const flag=validTargets(feedback).get(lesson.feedback_id);if(lesson.status!=='ready'||!flag||flag.target_key!==lesson.target_key||!supported(lesson,flag))throw new Error('Only a supported lesson for active feedback can be applied.');C.validateStored(lesson.analysis);}doc.actions.push({lesson_id:id,action:apply?'apply':'disable',at:new Date().toISOString()});});}
function generatedRules(doc,feedback,labels={}){
 return consolidated(doc,feedback).map(lesson=>{
  const suffix=S.sha(`${lesson.feedback_action}:${lesson.analysis.cue}:${lesson.feedback_ids.join(':')}`).slice(0,16),support=lesson.support_count>1?` · ${lesson.support_count} examples`:'';
  const trace={feedback_id:lesson.feedback_id,feedback_ids:lesson.feedback_ids,support_count:lesson.support_count};
  if(lesson.feedback_action==='confirmed_hit')return {kind:'hit',id:`custom_learned_hit_${suffix}`,label:`Confirmed · ${labels[lesson.analysis.cue]||lesson.analysis.cue.replaceAll('_',' ')}${support}`,text:lesson.analysis.check,...trace};
  return {kind:'exclusion',id:`custom_learned_no_${suffix}`,text:lesson.analysis.check,...trace};
 });
}
module.exports={load,update,enabled,consolidated,view,add,setActive,generatedRules};
