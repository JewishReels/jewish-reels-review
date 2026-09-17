const BULK_PAGE_SIZE = 12;
let bulkPage = 0, bulkBusy = false, bulkRenderToken = 0, bulkSearchTimer = null, bulkGroupSource = null, bulkGroups = [];
const bulkSelected = new Map(), bulkImagePromises = new Map();

function bulkUniqueHits() {
  if (entries === bulkGroupSource) return bulkGroups;
  const groups = new Map();
  for (const entry of entries.slice().reverse()) {
    if (entry.verdict !== 'jewish') continue;
    const key = entry.feedback_target || `missing:${entry.id}`;
    const existing = groups.get(key);
    if (existing) existing.copies.push(entry);
    else groups.set(key, { key, entry, copies: [entry] });
  }
  bulkGroupSource = entries; bulkGroups = [...groups.values()]; return bulkGroups;
}

function bulkStatus(entry) {
  return isConfirmedHit(entry) ? 'confirmed_hit' : isFalseHit(entry) ? 'false_hit' : 'unlabeled';
}

function bulkHaystack(group) {
  const entry = group.entry, cues = Array.isArray(entry.cues) ? entry.cues : entry.cues ? [entry.cues] : [];
  return [entry.id, entry.title, entry.summary, entry.method, entry.url, ...cues, ...group.copies.map(copy => copy.id)].filter(Boolean).join(' ').toLowerCase();
}

function bulkFilteredGroups() {
  const status = $('bulkStatusFilter').value, query = $('bulkSearch').value.trim().toLowerCase();
  return bulkUniqueHits().filter(group => (status === 'all' || bulkStatus(group.entry) === status) && (!query || bulkHaystack(group).includes(query)));
}

function bulkLabelText(entry) {
  const status = bulkStatus(entry);
  return status === 'confirmed_hit' ? 'CONFIRMED' : status === 'false_hit' ? 'REJECTED' : 'UNLABELED';
}

function bulkSelectionState() {
  const active = new Set(bulkUniqueHits().filter(group => bulkStatus(group.entry) === 'unlabeled' && group.entry.feedback_target).map(group => group.key));
  for (const key of bulkSelected.keys()) if (!active.has(key)) bulkSelected.delete(key);
  const count = bulkSelected.size;
  $('bulkSelectedCount').textContent = `${count.toLocaleString()} selected`;
  $('bulkConfirm').disabled = bulkBusy || !count;
  $('bulkReject').disabled = bulkBusy || !count || !$('bulkReason').value;
  $('bulkSelectPage').disabled = bulkBusy || !document.querySelector('.bulk-hit-check:not(:disabled)');
  $('bulkClearSelection').disabled = bulkBusy || !count;
  $('bulkReason').disabled = bulkBusy;
  $('bulkNote').disabled = bulkBusy;
}

function bulkImage(relative) {
  if (!relative) return Promise.resolve(null);
  if (!bulkImagePromises.has(relative)) {
    const pending = api.call('match-image', { relative, full: false, maxWidth: 480, maxHeight: 360 }).catch(error => {
      bulkImagePromises.delete(relative);
      throw error;
    });
    bulkImagePromises.set(relative, pending);
    trimCache(bulkImagePromises, 24);
  }
  return bulkImagePromises.get(relative);
}

async function loadBulkThumbnail(group, image, fallback, token) {
  try {
    const detail = await getResultDetail(group.entry);
    if (token !== bulkRenderToken || !image.isConnected) return;
    const data = await bulkImage(matchRelative(detail));
    if (token !== bulkRenderToken || !image.isConnected) return;
    if (!data) { fallback.textContent = 'No saved evidence image'; return; }
    image.src = data.data; image.hidden = false; fallback.hidden = true;
  } catch (error) {
    if (token === bulkRenderToken && fallback.isConnected) fallback.textContent = error.message;
  }
}

async function loadBulkThumbnails(tasks, token) {
  let next = 0;
  const worker = async () => { while (next < tasks.length && token === bulkRenderToken) { const task = tasks[next++]; await loadBulkThumbnail(...task, token); } };
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, worker));
}

function bulkCard(group, tasks) {
  const entry = group.entry, status = bulkStatus(entry), locked = status !== 'unlabeled' || !entry.feedback_target;
  const article = el('article', `bulk-card ${status}${bulkSelected.has(group.key) ? ' selected' : ''}`);
  const choice = el('label', 'bulk-card-choice');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.className = 'bulk-hit-check'; checkbox.checked = bulkSelected.has(group.key); checkbox.disabled = locked || bulkBusy; checkbox.setAttribute('aria-label', `Select ${entry.id}`);
  checkbox.bulkGroup = group;
  const badge = el('span', `pill ${status === 'confirmed_hit' ? 'confirmed-hit' : status === 'false_hit' ? 'false-hit' : 'hit'}`, bulkLabelText(entry));
  choice.append(checkbox, badge);
  const media = el('div', 'bulk-card-media'), image = document.createElement('img'), fallback = el('span', 'bulk-image-status', 'Loading evidence…');
  image.alt = `Saved evidence for ${entry.id}`; image.hidden = true; media.append(image, fallback); tasks.push([group, image, fallback]);
  const body = el('div', 'bulk-card-body'), heading = el('div', 'bulk-card-heading');
  heading.append(el('strong', '', String(entry.id)), group.copies.length > 1 ? el('span', 'bulk-copy-count', `${group.copies.length} linked records`) : document.createTextNode(''));
  const cues = Array.isArray(entry.cues) ? entry.cues : entry.cues ? [entry.cues] : [];
  const cue = cues.map(prettyCue).join(' / ') || 'Strict visual hit';
  body.append(heading, el('h3', '', entry.title || 'Untitled source'), el('p', 'bulk-cue', cue), el('p', 'bulk-summary', entry.summary || 'No evidence description was saved.'));
  if (locked) body.append(el('p', 'bulk-locked-note', status === 'unlabeled' ? 'Refresh this project before labeling.' : 'Open this hit to change or undo its current label.'));
  const inspect = el('button', 'button subtle bulk-inspect', 'Inspect evidence'); inspect.type = 'button'; inspect.onclick = act(() => openEvidence(entry)); body.append(inspect);
  checkbox.onchange = () => { if (checkbox.checked) bulkSelected.set(group.key, entry); else bulkSelected.delete(group.key); article.classList.toggle('selected', checkbox.checked); bulkSelectionState(); };
  article.append(choice, media, body); return article;
}

function renderBulkLabels() {
  if ($('bulkLabelView').hidden) { bulkRenderToken++; return; }
  const all = bulkUniqueHits(), unlabeled = all.filter(group => bulkStatus(group.entry) === 'unlabeled').length;
  $('bulkLabelNavCount').textContent = unlabeled.toLocaleString(); $('bulkLabelNav').title = `${unlabeled.toLocaleString()} unlabeled unique hits`;
  $('bulkUnlabeledCount').textContent = unlabeled.toLocaleString();
  const filtered = bulkFilteredGroups(), pages = Math.max(1, Math.ceil(filtered.length / BULK_PAGE_SIZE));
  bulkPage = Math.min(bulkPage, pages - 1);
  const start = bulkPage * BULK_PAGE_SIZE, visible = filtered.slice(start, start + BULK_PAGE_SIZE), token = ++bulkRenderToken, tasks = [];
  $('bulkGrid').replaceChildren(...visible.map(group => bulkCard(group, tasks)));
  $('bulkEmpty').hidden = visible.length > 0; $('bulkResultCount').textContent = filtered.length.toLocaleString();
  $('bulkPageStatus').textContent = filtered.length ? `Page ${bulkPage + 1} of ${pages}` : '';
  $('bulkRange').textContent = filtered.length ? `Showing ${start + 1}–${Math.min(start + BULK_PAGE_SIZE, filtered.length)} of ${filtered.length.toLocaleString()} unique hits` : 'No matching hits';
  $('bulkPrevious').disabled = bulkBusy || bulkPage === 0; $('bulkNext').disabled = bulkBusy || bulkPage >= pages - 1;
  bulkSelectionState(); loadBulkThumbnails(tasks, token);
}
window.renderBulkLabels = renderBulkLabels;
window.invalidateBulkLabels = () => { bulkGroupSource = null; };
window.suspendBulkLabels = () => { bulkRenderToken++; };

async function populateBulkReasons() {
  try {
    const reasons = await api.call('feedback-reasons');
    $('bulkReason').append(...reasons.map(reason => { const option = el('option', '', reason.label); option.value = reason.id; return option; }));
  } catch (error) { toast(error.message, true); }
}

async function saveBulkLabels(action) {
  if (bulkBusy || !bulkSelected.size) return;
  bulkBusy = true; renderBulkLabels();
  try {
    const items = [...bulkSelected.values()].map(entry => ({ id: String(entry.id), expectedTarget: entry.feedback_target }));
    const result = await api.call('save-bulk-hit-feedback', { items, action, reason: $('bulkReason').value, note: $('bulkNote').value });
    bulkSelected.clear(); $('bulkNote').value = ''; if (action === 'false_hit') $('bulkReason').value = '';
    loadProject(result.project);
    const verb = action === 'confirmed_hit' ? 'confirmed' : 'rejected';
    toast(`${result.saved.toLocaleString()} unique hit${result.saved === 1 ? '' : 's'} ${verb}. Retraining will use ${result.saved === 1 ? 'this label' : 'these labels'}.${result.skipped ? ` ${result.skipped} already had that label.` : ''}`);
  } finally { bulkBusy = false; renderBulkLabels(); }
}

$('bulkStatusFilter').onchange = () => { bulkPage = 0; renderBulkLabels(); };
$('bulkSearch').oninput = () => { clearTimeout(bulkSearchTimer); bulkSearchTimer = setTimeout(() => { bulkPage = 0; renderBulkLabels(); }, 120); };
$('bulkReason').onchange = bulkSelectionState;
$('bulkSelectPage').onclick = () => { for (const checkbox of document.querySelectorAll('.bulk-hit-check:not(:disabled)')) { checkbox.checked = true; const group = checkbox.bulkGroup; bulkSelected.set(group.key, group.entry); checkbox.closest('.bulk-card').classList.add('selected'); } bulkSelectionState(); };
$('bulkClearSelection').onclick = () => { bulkSelected.clear(); renderBulkLabels(); };
$('bulkPrevious').onclick = () => { if (bulkPage > 0) { bulkPage--; renderBulkLabels(); $('bulkGrid').scrollTop = 0; } };
$('bulkNext').onclick = () => { bulkPage++; renderBulkLabels(); $('bulkGrid').scrollTop = 0; };
$('bulkConfirm').onclick = act(() => saveBulkLabels('confirmed_hit'));
$('bulkReject').onclick = act(() => saveBulkLabels('false_hit'));
populateBulkReasons(); renderBulkLabels();
