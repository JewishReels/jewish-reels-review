const F = require('./feedback.cjs');

function summary(entry) {
  const hit = entry.verdict === 'jewish';
  const value = {
    id: entry.id,
    verdict: entry.verdict,
    source_key: entry.source_key || null,
    title: entry.title || '',
    cards_reviewed_count: entry.cards_reviewed_count ?? (Array.isArray(entry.cards_reviewed) ? entry.cards_reviewed.length : entry.cards_reviewed ?? null),
    reviewed_at: entry.reviewed_at || null,
  };
  if (hit) Object.assign(value, {
    cues: entry.cues || [],
    summary: entry.summary || '',
    confidence: entry.confidence ?? null,
    method: entry.method || '',
    copied_from: entry.copied_from || null,
    scope: entry.scope || null,
    segment_start: entry.segment_start ?? null,
    segment_end: entry.segment_end ?? null,
    url: entry.url || '',
    feedback_target: entry.feedback_target,
    human_review: entry.human_review,
    evidence_available: !!(entry.human_review?.evidence_image || entry.evidence?.card_path || entry.evidence_hits?.some(hit=>hit?.card_path)),
    evidence_hit_count: Array.isArray(entry.evidence_hits) && entry.evidence_hits.length ? entry.evidence_hits.length : entry.evidence ? 1 : 0,
  });
  return value;
}

function summaries(entries, journal) {
  const values=[],hits=new Map();
  for(const entry of F.annotate(entries,journal)){
    const value=summary(entry);
    if(entry.verdict!=='jewish'){values.push(value);continue;}
    const key=value.feedback_target||F.targetKey(entry),existing=hits.get(key);
    if(!existing){
      value.catalog_ids=[String(value.id)];value.catalog_id_count=1;
      value.source_keys=value.source_key?[value.source_key]:[];value.source_count=value.source_keys.length;
      hits.set(key,value);values.push(value);continue;
    }
    if(!existing.catalog_ids.includes(String(value.id)))existing.catalog_ids.push(String(value.id));
    existing.catalog_id_count=existing.catalog_ids.length;
    if(value.source_key&&!existing.source_keys.includes(value.source_key))existing.source_keys.push(value.source_key);
    existing.source_count=existing.source_keys.length;
  }
  return values;
}

function detail(entries, journal, id) {
  const entry = entries.find(value => String(value.id) === String(id));
  return entry ? F.annotate([entry], journal)[0] : null;
}

module.exports = { summary, summaries, detail };
