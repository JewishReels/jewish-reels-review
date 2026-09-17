const { createHash } = require('node:crypto');
const VERSION = 2;
const PREPROCESSING = 'siglip2-224-people-margin-five-views-v1';
const MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';
const MODEL_REVISION = 'ba1f3b0843f24bc5417d38e19c37b287d719b2f4';
const VISION_SHA256 = '5f2b401c1a4fc095702a5d45348e17ad46c4f87064085365b43c6e8eaa5c0070';
const CATALOG = [{id:'people',label:'People',prompts:[
'A photograph of a person.','A photograph of people.','An archival film frame showing people.',
'A person standing in the distance.','A crowd of people in a street.','A close up of a human face.',
'A person seen from behind.','People sitting indoors.','A child in a film frame.',
'Part of a person visible in a photograph.'
],negativePrompts:[
'An empty scene with no people.','An empty street with buildings and no people.',
'A photograph of architecture.','A photograph of gravestones in a cemetery.',
'A landscape with trees and no people.','An intertitle with writing on a plain background.',
'A page of text.','A black screen.','Television color bars.','An empty room.',
'A close up of an object.','A photograph of a statue.','A portrait painted on a wall.',
'A train with no people visible.'
]}];
const LEGACY_CUES = ['orthodox_religious_dress','orthodox_beard_hat','shtreimel','payot','kippah_religious_setting','tallit_tefillin','synagogue_ark_bimah','jewish_cemetery_hebrew','star_of_david_subject','hebrew_religious_communal_text','yellow_judenstern','jude_shop_marking','judaica','jewish_ritual_ceremony'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CATALOG_HASH = hash(CATALOG);
function normalize(value = {}) {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid frame filter settings.');
 if (value.version !== undefined && ![1,VERSION].includes(value.version)) throw new Error('Unsupported frame filter settings version.');
 let ids=value.cues===undefined?['people']:value.cues;
 if(!Array.isArray(ids))throw new Error('Choose People from the fixed checklist.');
 // Earlier settings described archival traits. Migrate preferences, never old scores or results.
 if(value.version===1 && ids.every(id=>LEGACY_CUES.includes(id)))ids=ids.length?['people']:[];
 if(ids.some(id=>id!=='people'))throw new Error('Choose People from the fixed checklist.');
 const cues=ids.includes('people')?['people']:[];
 if(value.enabled===true&&!cues.length)throw new Error('Select at least one frame choice: People.');
 return {version:VERSION,enabled:value.enabled===true,cues};
}
function fingerprint(config, assetHash) { return hash({config:normalize(config),assetHash,preprocessing:PREPROCESSING,catalog:CATALOG_HASH}); }
function match(scores, config, thresholds) {
 const cfg=normalize(config);
 return cfg.cues.filter(id=>Number.isFinite(scores[id])&&scores[id]>=thresholds[id]);
}
module.exports={VERSION,PREPROCESSING,MODEL,MODEL_REVISION,VISION_SHA256,CATALOG,CATALOG_HASH,hash,normalize,fingerprint,match};
