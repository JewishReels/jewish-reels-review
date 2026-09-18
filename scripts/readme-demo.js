(function () {
let contextBridge = null;
let criteriaView = {
  hits: [
    { id: 'orthodox_beard_hat', label: 'Orthodox beard · hat', prompt: 'A full beard and a dark brimmed street hat are visible on the same person.', enabled: true, custom: false },
    { id: 'kippah_religious_setting', label: 'Kippah / yarmulke', prompt: 'A visibly distinct small round Jewish skullcap is worn on a person.', enabled: true, custom: false },
    { id: 'tallit_tefillin', label: 'Tallit / tefillin', prompt: 'A prayer shawl or tefillin is visibly resolved.', enabled: true, custom: false }
  ],
  exclusions: [{ id: 'ambiguous', text: 'ambiguous or unreadable details', enabled: true, custom: false }],
  customized: false, labels: {}
};
if (typeof require === 'function') {
  ({ contextBridge } = require('electron'));
  criteriaView = require('../lib/criteria.cjs').view();
}

// Documentation screenshots use synthetic records so that regenerating them can
// never disclose a user's footage, search history, API key, or local workspace.
const syntheticSheet = String.raw`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900">
  <defs>
    <linearGradient id="paper" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d8c9a8"/><stop offset="1" stop-color="#a89068"/></linearGradient>
    <filter id="grain"><feTurbulence baseFrequency=".72" numOctaves="3" seed="7" type="fractalNoise"/><feColorMatrix values=".12 0 0 0 .2  0 .1 0 0 .16  0 0 .08 0 .1  0 0 0 .24 0"/></filter>
  </defs>
  <rect width="1600" height="900" fill="#19130d"/>
  <g fill="#d8c8a4">
    <rect x="28" y="24" width="44" height="25" rx="4"/><rect x="118" y="24" width="44" height="25" rx="4"/><rect x="208" y="24" width="44" height="25" rx="4"/><rect x="298" y="24" width="44" height="25" rx="4"/><rect x="388" y="24" width="44" height="25" rx="4"/><rect x="478" y="24" width="44" height="25" rx="4"/><rect x="568" y="24" width="44" height="25" rx="4"/><rect x="658" y="24" width="44" height="25" rx="4"/><rect x="748" y="24" width="44" height="25" rx="4"/><rect x="838" y="24" width="44" height="25" rx="4"/><rect x="928" y="24" width="44" height="25" rx="4"/><rect x="1018" y="24" width="44" height="25" rx="4"/><rect x="1108" y="24" width="44" height="25" rx="4"/><rect x="1198" y="24" width="44" height="25" rx="4"/><rect x="1288" y="24" width="44" height="25" rx="4"/><rect x="1378" y="24" width="44" height="25" rx="4"/><rect x="1468" y="24" width="44" height="25" rx="4"/>
    <rect x="28" y="851" width="44" height="25" rx="4"/><rect x="118" y="851" width="44" height="25" rx="4"/><rect x="208" y="851" width="44" height="25" rx="4"/><rect x="298" y="851" width="44" height="25" rx="4"/><rect x="388" y="851" width="44" height="25" rx="4"/><rect x="478" y="851" width="44" height="25" rx="4"/><rect x="568" y="851" width="44" height="25" rx="4"/><rect x="658" y="851" width="44" height="25" rx="4"/><rect x="748" y="851" width="44" height="25" rx="4"/><rect x="838" y="851" width="44" height="25" rx="4"/><rect x="928" y="851" width="44" height="25" rx="4"/><rect x="1018" y="851" width="44" height="25" rx="4"/><rect x="1108" y="851" width="44" height="25" rx="4"/><rect x="1198" y="851" width="44" height="25" rx="4"/><rect x="1288" y="851" width="44" height="25" rx="4"/><rect x="1378" y="851" width="44" height="25" rx="4"/><rect x="1468" y="851" width="44" height="25" rx="4"/>
  </g>
  <g transform="translate(38 77)">
    <g transform="translate(0 0)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><path d="M0 238L130 168l120 44 120-94 120 78v134H0Z" fill="#817052"/><circle cx="130" cy="73" r="39" fill="#352b20"/><path d="M65 80h133l-25-20H94Z" fill="#211a14"/><path d="M83 280q16-126 49-156 41 37 56 156Z" fill="#2b231b"/><circle cx="330" cy="119" r="30" fill="#4c3c2b"/><path d="M275 122h111l-19-19h-70Z" fill="#241b13"/><path d="M284 286q13-102 48-137 38 42 50 137Z" fill="#453725"/></g>
    <g transform="translate(517 0)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><rect y="231" width="490" height="99" fill="#79684b"/><path d="M45 226L110 92l65 134M177 226l71-171 76 171M335 226l55-124 55 124" stroke="#5d4c35" stroke-width="18" fill="none"/><circle cx="254" cy="114" r="38" fill="#30261c"/><path d="M181 117h151l-28-22h-90Z" fill="#1f1812"/><path d="M193 300q15-122 62-151 47 38 61 151Z" fill="#2a2119"/><path d="M249 148q-18 56 8 93 30-41 5-94" fill="#6e573a"/></g>
    <g transform="translate(1034 0)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><path d="M0 250Q120 170 236 220T490 190v140H0Z" fill="#756348"/><rect x="36" y="56" width="182" height="157" fill="#8c7856"/><path d="M36 56l91-43 91 43" fill="#54442f"/><circle cx="347" cy="96" r="35" fill="#382c20"/><path d="M280 101h136l-20-23h-91Z" fill="#231a12"/><path d="M294 289q14-119 55-156 40 35 56 156Z" fill="#2c231a"/></g>
    <g transform="translate(0 357)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><rect y="215" width="490" height="115" fill="#736043"/><path d="M30 211h430M67 211V98h356v113" stroke="#51402c" stroke-width="17"/><circle cx="148" cy="144" r="28" fill="#3e3022"/><path d="M100 146h98l-18-17h-61Z" fill="#251b13"/><circle cx="330" cy="139" r="30" fill="#423225"/><path d="M275 142h111l-20-18h-70Z" fill="#211913"/><path d="M111 300q11-98 39-127 35 31 45 127M290 300q11-97 42-130 36 35 48 130" fill="#30251b"/></g>
    <g transform="translate(517 357)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><path d="M0 229Q105 187 216 220t274-15v125H0Z" fill="#7e6a4c"/><circle cx="117" cy="121" r="31" fill="#413225"/><path d="M61 124h116l-22-19H84Z" fill="#251c14"/><path d="M72 293q14-104 47-137 37 34 50 137Z" fill="#33281e"/><circle cx="270" cy="105" r="34" fill="#372b20"/><path d="M207 109h130l-22-22h-82Z" fill="#211912"/><path d="M221 291q12-112 52-149 42 41 55 149Z" fill="#2a2119"/><circle cx="399" cy="135" r="27" fill="#4b3a29"/><path d="M351 138h101l-19-17h-64Z" fill="#261d15"/><path d="M363 294q10-91 38-125 32 30 43 125Z" fill="#3b2e21"/></g>
    <g transform="translate(1034 357)"><rect width="490" height="330" rx="5" fill="url(#paper)"/><rect y="221" width="490" height="109" fill="#786548"/><path d="M34 221v-98h181v98M278 221V76h167v145" stroke="#54432e" stroke-width="16"/><circle cx="241" cy="158" r="28" fill="#3d2e21"/><path d="M191 161h103l-18-18h-65Z" fill="#221912"/><path d="M202 301q11-93 41-111 32 24 43 111Z" fill="#30251b"/></g>
  </g>
  <rect width="1600" height="900" filter="url(#grain)" opacity=".22"/>
  <text x="800" y="831" fill="#e4d6b7" font-family="Georgia,serif" font-size="24" text-anchor="middle" letter-spacing="3">SYNTHETIC DEMONSTRATION IMAGE · NO ARCHIVAL FOOTAGE</text>
</svg>`;

const sheetData = contextBridge
  ? `data:image/svg+xml;base64,${Buffer.from(syntheticSheet).toString('base64')}`
  : new URL('.readme-evidence.png', location.href).href;
const reviewedAt = '2026-09-14T18:22:00.000Z';

function hit(id, title, cue, summary, x, y, copies = 1) {
  const evidence = {
    card: 'card_000012.jpg',
    card_path: `synthetic/${id}/card_000012.jpg`,
    bounds: { x, y, width: 220, height: 245 },
    primary: {
      model: 'Qwen 3.7 Flash', cue,
      evidence: summary,
      location: 'Center-right frame, foreground figures'
    },
    frame_map: [{ timestamp: 12 }, { timestamp: 13 }, { timestamp: 14 }]
  };
  return {
    id, title, verdict: 'jewish', cues: [cue], summary, confidence: 0.91,
    cards_reviewed_count: 12, reviewed_at: reviewedAt,
    feedback_target: `sha256:synthetic-${id}`, catalog_id_count: copies,
    catalog_ids: Array.from({ length: copies }, (_, index) => index ? `${id}-copy-${index}` : id),
    evidence, evidence_hits: [evidence, { ...evidence, card: 'card_000018.jpg', card_path: `synthetic/${id}/card_000018.jpg`, bounds: { x: 635, y: 455, width: 230, height: 225 } }]
  };
}

const entries = [
  { id: 'demo-0001', title: 'Synthetic market street (demo)', verdict: 'no', summary: 'Street scene without a qualifying visible cue.', cards_reviewed_count: 15, reviewed_at: reviewedAt },
  hit('demo-0002', 'Synthetic prayer gathering (demo)', 'tallit_tefillin', 'A striped prayer shawl is clearly visible on the foreground figure.', 90, 112),
  { ...hit('demo-0003', 'Synthetic community procession (demo)', 'jewish_ritual_ceremony', 'A clearly visible ritual object and coordinated religious ceremony appear together.', 1045, 115), human_review: { status: 'confirmed_hit', note: 'Clear ceremonial context.' } },
  { ...hit('demo-0004', 'Synthetic interior scene (demo)', 'synagogue_ark_bimah', 'The raised reading platform and ark-like structure are visibly identifiable.', 285, 470), human_review: { status: 'false_hit', reason: 'architectural_lookalike', note: 'Generic stage.' } },
  { id: 'demo-0005', title: 'Synthetic station platform (demo)', verdict: 'filtered_no', summary: 'No people or qualifying visual cue in the sampled frames.', cards_reviewed_count: 9, reviewed_at: reviewedAt },
  hit('demo-0007', 'Synthetic dockside gathering (demo)', 'orthodox_beard_hat', 'Several foreground figures wear dark brimmed fedoras with visibly upturned brims and traditional dark dress.', 1325, 125, 3)
];

const project = {
  root: 'C:\\Jewish Reels\\Demo Workspace', videoCount: 368, cardCount: 2847,
  entries, feedback: { active: 2 }
};

const preparation = {
  status: 'running', activeSource: 'footage-farm', message: 'Preparing the next reel while ready cards are reviewed.',
  counts: { total: 368, pending: 219, error: 2, hit: 31, cleaned: 114, ready: 4, resolving: 1, downloading: 1, extracting: 1 },
  backlog: { ahead_reels: 4, target: 5, ahead_cards: 37, ahead_frames: 744, ready_reels: 4 },
  bytes: 7945689498, reclaimed: 15247133900,
  current: { id: 'demo-0142', stage: 'screening', screened: 438, total: 612, selected: 301, localWorkers: 8, parallelVideos: 3 },
  sources: [
    { key: 'footage-farm', label: 'Footage Farm catalog', kind: 'crawled', total: 328 },
    { key: 'curated-import', label: 'Curated archive leads', kind: 'imported', total: 40 }
  ],
  recent: [
    { id: 'demo-0141', title: 'Synthetic city gathering — reel 3', status: 'ready', duration: 531, frame_count: 542, card_count: 27 },
    { id: 'demo-0140', title: 'Synthetic community scenes — reel 7', status: 'hit', duration: 407, frame_count: 414, card_count: 21 },
    { id: 'demo-0139', title: 'Synthetic railway arrivals — reel 2', status: 'cleaned', duration: 622, frame_count: 628, card_count: 32 },
    { id: 'demo-0142', title: 'Synthetic dockside scenes — reel 4', status: 'extracting', duration: 0, frame_count: 301, card_count: 0 },
    { id: 'demo-0138', title: 'Synthetic market day — reel 5', status: 'ready', duration: 288, frame_count: 295, card_count: 15 }
  ]
};

const active = Array.from({ length: 11 }, (_, index) => ({
  worker: index + 1,
  id: `demo-${String(152 + (index % 4)).padStart(4, '0')}`,
  card: `card_${String(18 + index).padStart(6, '0')}.jpg`,
  region: 1 + (index % 4), role: 'primary', model: 'Qwen 3.7 Flash'
}));

const state = {
  status: 'running', message: 'Reviewing four videos concurrently · completed regions are checkpointed locally.',
  done: 146, total: 368, cardsReviewed: 1284, regionsReviewed: 7462,
  spend: 1.284, totalSpend: 4.736, attempts: 7489, failedRequests: 7,
  workers: 16, videoConcurrency: 4, dispatchMode: 'concurrent', active,
  videos: [
    { id: 'demo-0152', title: 'Synthetic reel', completedCards: 8, cardsTotal: 19, regionsSaved: 47, active: active.slice(0, 3), current: { card: 'card_000026.jpg' } },
    { id: 'demo-0153', title: 'Synthetic reel', completedCards: 11, cardsTotal: 22, regionsSaved: 64, active: active.slice(3, 6), current: { card: 'card_000019.jpg' } },
    { id: 'demo-0154', title: 'Synthetic reel', completedCards: 5, cardsTotal: 17, regionsSaved: 31, active: active.slice(6, 9), current: { card: 'card_000023.jpg' } },
    { id: 'demo-0155', title: 'Synthetic reel', completedCards: 3, cardsTotal: 14, regionsSaved: 18, active: active.slice(9), current: { card: 'card_000011.jpg' } }
  ],
  requests: 7458, retries: 3, networkRetries: 2, providerRetries: 2, formatRetries: 1,
  processingMs: 36 * 60 * 1000, processingActive: false, sessionVideos: 146, sessionReused: 9,
  current: { id: 'demo-0152', card: 'card_000026.jpg', region: 3, cardsTotal: 19 },
  completedCardsCurrent: 8, regionsReviewedCurrent: 47, events: [
    { at: '2026-09-14T18:22:11Z', kind: 'hit', message: 'demo-0148 · strict visual hit saved · source retained' },
    { at: '2026-09-14T18:22:08Z', kind: 'success', message: 'demo-0153 · card_000019.jpg · region 2 saved' },
    { at: '2026-09-14T18:22:04Z', kind: 'success', message: 'demo-0154 · card_000023.jpg · region 1 saved' }
  ]
};

const models = [{
  id: 'qwen/qwen3.7-flash', name: 'Qwen 3.7 Flash',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.00000025', completion: '0.00000075' }
}, {
  id: 'openai/gpt-6-astra', name: 'GPT-6 Astra',
  architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
  pricing: { prompt: '0.00000125', completion: '0.000005' }
}];

const recheck = {
  status: 'complete', sourceHitRecords: 91, sourceEvidenceRows: 109, uniqueImages: 87,
  completed: 87, confirmed: 74, rejectedPrimary: 11, errors: 2, requests: 89, spend: 0.0831,
  policy: 'strict-visual-10', reportAvailable: true,
  message: 'Saved evidence recheck complete.',
  last: { index: 87, video_ids: ['demo-0007'], final: 'confirmed_hit', primary: 'orthodox_beard_hat' }
};

async function call(method, ...args) {
  switch (method) {
    case 'bootstrap': return {
      version: '2.4.58',
      settings: { folder: project.root, activeSource: 'footage-farm', primary: models[0].id, secondary: '', verification: false, verificationMode: 'positives', detail: true, budget: 10, workers: 16, videoConcurrency: 4, dispatchMode: 'concurrent', recheckBudget: 10, recheckWorkers: 16, autoBackfill: true, preparation: { fps: 2, width: 960, buffer: 5, maxGB: 20 } },
      connection: { configured: true, remembered: true, environment: false }, state, recheck, preparation,
      sources: [{ label: 'Demo URL collection', file: 'synthetic-demo-urls.txt' }], criteria: criteriaView
    };
    case 'reopen-project':
    case 'refresh-project': return project;
    case 'get-preparation': return preparation;
    case 'get-models': return { models, cached: false };
    case 'result-detail': return entries.find(entry => String(entry.id) === String(args[0])) || entries.at(-1);
    case 'match-image': return { data: sheetData, full: !!args[0]?.full, originalSize: { width: 1600, height: 900 }, size: { width: 1600, height: 900 } };
    case 'hit-recheck-info': return recheck;
    case 'hit-recheck-results': return { results: [] };
    case 'feedback-reasons': return [{ id: 'not_distinctive', label: 'Visible cue is not distinctive' }, { id: 'lookalike', label: 'Object or clothing is a lookalike' }];
    case 'get-criteria': return criteriaView;
    case 'get-learning': return { state: { status: 'idle' }, cases: [], lessons: [], model: models[0].id, budget: 1 };
    default: return null;
  }
}

const subscribe = () => {};
const demoApi = {
  call,
  onState: subscribe, onLearning: subscribe, onLearningUpdated: subscribe,
  onHitRecheck: subscribe, onVerdict: subscribe, onPreparation: subscribe, onProject: subscribe
};
if (contextBridge) contextBridge.exposeInMainWorld('reelsight', demoApi);
else {
  globalThis.reelsight = demoApi;
  addEventListener('DOMContentLoaded', () => {
    const chooseView = () => {
      if (!document.title.includes('2.4.58') || document.getElementById('folderName')?.textContent !== 'Demo Workspace') return setTimeout(chooseView, 50);
      if (location.hash === '#review') document.getElementById('reviewNav').click();
      if (location.hash === '#matches') document.getElementById('matchesNav').click();
    };
    chooseView();
  });
}
})();
