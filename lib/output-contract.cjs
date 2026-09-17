const { validateResult } = require('./policy.cjs');
const CONTRACT_VERSION = 'visual-json-4';
const FIELDS = ['decision','cue','evidence','location','confidence','box'];
// There are six JSON fields. Metadata is added by the app only after validation.
const GUIDANCE = Object.freeze({
  json: 'Return exactly one complete JSON object, without prose or a list.',
  fields: 'Use exactly decision, cue, evidence, location, confidence, box. Include every field; no extra keys.',
  types: 'decision, cue, evidence and location must be strings. confidence must be a JSON number from 0 to 1.',
  evidence: 'Include a brief visible-facts explanation even when the decision is no. Do not invent evidence.',
  contradiction: 'For a visual no, cue must be exactly "none" and box must be JSON null. For a visual hit, use an allowed cue and a valid box.',
  no_box: 'The previous answer said decision "no" and cue "none" but did not use JSON null for box. For no, cue must be exactly "none" and box must be JSON null, not a rectangle or the string "null". A rectangle around ordinary scenery or the visible film frame is not requested. Re-inspect the pixels; if your decision remains "no", use the literal JSON fields "cue":"none", "location":"", "box":null. Do not change no to hit to justify the rectangle.',
  box: 'ONLY IF decision is "hit", box must be [left, top, width, height] using ONLY fractions between 0 and 1, relative to the ENTIRE input region. Do not use pixels, percentages or a 0-1000 scale. Width and height must be positive, and the rectangle must remain inside the image. If decision is "no", box must instead be JSON null; do not box ordinary scenery or the film frame.',
  hit: 'A hit needs one allowed cue, concrete visible evidence, a frame location and a valid normalized box. If the visual cue is uncertain, choose no.',
  truncated: 'The previous response was incomplete. Return a compact, complete JSON verdict for these same pixels.',
});
function invalid(issue, content) {
  const error = new Error(`Invalid model result: ${GUIDANCE[issue] || GUIDANCE.json}`);
  error.code = 'INVALID_VISUAL_RESULT'; error.validationIssue = issue;
  error.invalidResponse = typeof content === 'string' ? content.slice(0,6000) : null;
  return error;
}
function parseReview(content, validate = validateResult) {
  // Some compatible endpoints return text blocks. Accept text only; never reasoning/refusal/tool blocks.
  if (Array.isArray(content)) {
    if (!content.length || !content.every(p=>p?.type==='text' && typeof p.text==='string')) throw invalid('json',null);
    content=content.map(p=>p.text).join('');
  }
  if (typeof content!=='string' || !content.trim() || content.length>16000) throw invalid('json',content);
  const cleaned=content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  let value;
  try { value=JSON.parse(cleaned); } catch { throw invalid('json',content); }
  // JSON.parse otherwise silently keeps the last duplicate key, even a conflicting decision.
  let depth=0; const keys=new Set();
  for(let i=0;i<cleaned.length;i++) {
    const c=cleaned[i];
    if(c==='"') {
      const start=i; for(i++;i<cleaned.length;i++){if(cleaned[i]==='\\'){i++;continue;}if(cleaned[i]==='"')break;}
      let next=i+1;while(/\s/.test(cleaned[next]||'!'))next++;
      if(depth===1&&cleaned[next]===':'){const k=JSON.parse(cleaned.slice(start,i+1));if(keys.has(k))throw invalid('fields',content);keys.add(k);}
    } else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
  }
  if (!value || typeof value!=='object' || Array.isArray(value)) throw invalid('fields',content);
  const present=Object.keys(value);
  if (present.some(k=>!FIELDS.includes(k)) || !['decision','cue','evidence','location','box'].every(k=>Object.hasOwn(value,k))) throw invalid('fields',content);
  // json_object providers sometimes omit subjective confidence. A complete visual
  // decision is still usable; the app records 0 and labels it as uncalibrated.
  if (!Object.hasOwn(value,'confidence')) value={...value,confidence:0};
  if (!['decision','cue','evidence','location'].every(k=>typeof value[k]==='string') || !['hit','no'].includes(value.decision) || !Number.isFinite(value.confidence) || value.confidence<0 || value.confidence>1) throw invalid('types',content);
  if (value.evidence.trim().length<10 || value.evidence.length>1800 || value.location.length>400) throw invalid('evidence',content);
  if (value.decision==='no' && value.cue!=='none') throw invalid('contradiction',content);
  if (value.decision==='no' && value.box!==null) throw invalid('no_box',content);
  if (value.decision==='hit') {
    if (!Array.isArray(value.box) || value.box.length!==4 || value.box.some(n=>!Number.isFinite(n)||n<0||n>1) || value.box[2]<=0 || value.box[3]<=0 || value.box[0]+value.box[2]>1 || value.box[1]+value.box[3]>1) throw invalid('box',content);
  }
  try { return validate(value); } catch { throw invalid('hit',content); }
}
function outputMode(model, override) {
  const supported=Array.isArray(model.supported)?model.supported:[];
  const preferred=supported.includes('structured_outputs')?'schema':supported.includes('response_format')?'json':'prompt';
  if (override==='prompt') return 'prompt';
  if (override==='json' && supported.includes('response_format')) return 'json';
  return preferred;
}
function fallbackMode(model, mode) {
  if (mode==='schema') return model.supported?.includes('response_format')?'json':'prompt';
  if (mode==='json') return 'prompt';
  return null;
}
function imageInstruction(image, retry, issue) {
  const b=image.bounds;
  const dimensions=Number.isFinite(b?.width)&&Number.isFinite(b?.height)?` The supplied image region is ${b.width} pixels wide and ${b.height} pixels high. Normalize the box against these dimensions, not the original contact sheet.`:'';
  const base='Inspect this image region using the strict visual rule. Return the required JSON.'+dimensions+' A box locates positive Jewish evidence only. For no, output "cue":"none", "location":"", "box":null even when ordinary film content occupies only part of this region.';
  if (!retry) return base;
  const guidance=GUIDANCE[issue]||GUIDANCE.fields;
  const reminder=issue==='no_box' ? '' : ' '+GUIDANCE.contradiction+(issue==='box'||issue==='hit'?' '+GUIDANCE.box:'');
  return base+'\nA previous attempt was not a valid completed review. Independently re-inspect these same pixels. '+guidance+reminder+' Confidence must be a number from 0 to 1. Do not change your visual decision just to repair formatting, and do not infer a hit from this retry instruction.';
}
module.exports={CONTRACT_VERSION,parseReview,invalid,outputMode,fallbackMode,imageInstruction};
