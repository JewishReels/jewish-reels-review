const STOP_WORDS=new Set('a an the this that these those is are was were be been being and or of to in on at by for from as it its clearly visible actual image images frame frames evidence object objects subject scene scenes shows showing seen'.split(' '));

function canonical(text){return String(text||'').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,' ').trim();}
function stem(word){if(word.length>6)return word.replace(/(?:ingly|edly|ments|ment|ation|ations|ing|ers|ies|ied|ed|es|s)$/,'');return word;}
function tokens(text){return new Set(canonical(text).split(' ').filter(word=>word.length>2&&!STOP_WORDS.has(word)).map(stem).filter(word=>word.length>2));}
function similarity(left,right){
 const a=tokens(left),b=tokens(right);if(!a.size||!b.size)return {score:0,shared:0};
 let shared=0;for(const word of a)if(b.has(word))shared++;
 const containment=shared/Math.min(a.size,b.size),jaccard=shared/(a.size+b.size-shared);
 return {score:Math.max(jaccard,containment*.86),shared};
}
function overlap(left,right){const value=similarity(left,right);return value&&value.score||0;}

module.exports={canonical,overlap,similarity};
