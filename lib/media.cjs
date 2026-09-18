const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { webUrl } = require('./queue.cjs');
const S = require('./storage.cjs');
const { vimeoAuthArgs, isOfficialFootageFarmVimeo } = require('./vimeo-auth.cjs');
const M = require('./myfootage.cjs');
const UA = 'JewishReels/2.0 (archival footage preparation)';
const decodeHtml = s => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const corruptMediaPattern = /invalid data found when processing input|invalid nal unit|error splitting the input into nal units|error (?:submitting|processing) packet (?:to|in) decoder|error while decoding|corrupt(?:ed)? (?:decoded )?(?:frame|packet|input)|packet corrupt|moov atom not found|missing picture in access unit|decode_slice_header error|cabac decode of qscale diff failed|partial file/i;
function isCorruptMediaError(error) { return error?.mediaCorrupt === true || corruptMediaPattern.test(error?.message || ''); }
function markCorruptMediaError(error) { if (error && isCorruptMediaError(error)) error.mediaCorrupt = true; return error; }
function jpegFullRangeFilter(filter) { return `${filter},scale=iw:ih:in_range=auto:out_range=full,format=pix_fmts=yuvj420p`; }
function normalizeReelTitle(value) {
  return String(value || '').normalize('NFKC').replace(/[‐‑‒–—―−]/g, '-').replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toUpperCase();
}
function footageFarmMetadata(html) {
  const reel = decodeHtml(html.match(/<strong\b[^>]*>\s*Reel\s+Number\s*<\/strong>\s*:\s*([^<]+)/i)?.[1] || '').trim();
  const displayed = decodeHtml(html.match(/<strong\b[^>]*>\s*Duration\s*<\/strong>\s*:\s*([^<]+)/i)?.[1] || '').trim();
  const parts = displayed.split(':').map(Number);
  const duration = parts.length === 3 && parts.every(Number.isFinite) && parts[1] >= 0 && parts[1] < 60 && parts[2] >= 0 && parts[2] < 60 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : NaN;
  if (!reel || reel.length > 100 || !Number.isFinite(duration) || duration <= 0) return null;
  return { reel, duration };
}
function officialFootageFarmAuthor(data) {
  if (normalizeReelTitle(data?.author_name) !== 'FOOTAGE FARM') return false;
  try {
    const author = new URL(data.author_url);
    return author.protocol === 'https:' && /^(?:www\.)?vimeo\.com$/i.test(author.hostname) && author.pathname.replace(/\/+$/, '').toLowerCase() === '/footagefarm' && !author.search && !author.hash;
  } catch { return false; }
}
async function get(url, signal, fetchImpl = fetch, accept = 'text/html') {
  let last;
  const managed = fetchImpl.isManagedUrl?.(url) === true;
  const attempts = managed ? 1 : 5;
  const timeout = managed ? 160000 : 60000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(timeout)]) });
      if (response.ok) return response;
      const error = new Error(`Source HTTP ${response.status} (${new URL(url).hostname}).`); error.status = response.status; last = error;
      if (response.status !== 429 && response.status < 500) throw error;
    } catch (error) {
      last = error;
      if (signal?.aborted || error.status && error.status !== 429 && error.status < 500) throw error;
    }
    if (attempt < attempts - 1) await sleep(Math.min(8000, 500 * 2 ** attempt));
  }
  // A page-level DNS/socket/timeout/429/5xx failure is not evidence that the
  // catalog record is bad. The pipeline schedules another fresh resolution so
  // Footage Farm can recover after a longer outage without manual queue edits.
  if (last) last.sourceTransient = true;
  throw last;
}
async function resolveFootageFarmVimeo(identity, pageUrl, signal, fetchImpl) {
  if (!identity?.reel || !Number.isFinite(identity.duration)) return null;
  const searchUrl = `https://vimeo.com/footagefarm/videos/search:${encodeURIComponent(identity.reel)}/sort:date`;
  const search = await (await get(searchUrl, signal, fetchImpl)).text();
  const ids = [...new Set([...search.matchAll(/<li\b[^>]*\bid=["']clip_(\d+)["'][^>]*>/gi)].map(match => match[1]))];
  if (!ids.length) return null;
  const validated = (await Promise.all(ids.map(async id => {
    try {
      const response = await get(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`, signal, fetchImpl, 'application/json');
      let data;
      try { data = await response.json(); }
      catch (error) { error.sourceTransient = true; throw error; }
      if (String(data.video_id || '') !== id || normalizeReelTitle(data.title) !== normalizeReelTitle(identity.reel) || !officialFootageFarmAuthor(data)) return null;
      const duration = Number(data.duration);
      if (!Number.isFinite(duration) || Math.abs(duration - identity.duration) > 2) return null;
      return { provider: 'footagefarm-vimeo', url: `https://vimeo.com/${id}`, referer: pageUrl, direct: false, scope: 'whole-reel' };
    } catch (error) {
      if (error.sourceTransient) throw error;
      return null;
    }
  }))).filter(Boolean);
  return validated.length === 1 ? validated[0] : null;
}
async function resolveMedia(url, signal, fetchImpl = fetch) {
  const u = new URL(url); if (!webUrl(url)) throw new Error('Invalid video URL.');
  if (/(^|\.)filmhiradokonline\.hu$/i.test(u.hostname)) {
    const id = u.searchParams.get('id'); if (!/^\d+$/.test(id || '')) throw new Error('Hungarian item URL must include a numeric id.');
    const referer = `https://filmhiradokonline.hu/player.php?id=${id}`;
    const html = await (await get(referer, signal, fetchImpl)).text();
    const match = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i);
    if (!match) throw new Error('No public MP4 source found on the Hungarian player page.');
    const media = new URL(decodeHtml(match[1]), referer).href;
    const start = Number(html.match(/var\s+start\s*=\s*(\d+(?:\.\d+)?)/i)?.[1]), end = Number(html.match(/var\s+end\s*=\s*(\d+(?:\.\d+)?)/i)?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Hungarian story has no valid start/end range. Refusing to substitute the entire reel.');
    return { url: media, referer, direct: true, segment_start: start, segment_end: end, scope: 'segment' };
  }
  if (/(^|\.)archiv-akh\.de$/i.test(u.hostname) && /\/filme\/(\d+)/.test(u.pathname)) {
    const id = u.pathname.match(/\/filme\/(\d+)/)[1];
    const data = await (await get(`https://api.archiv-akh.de/data/material/id/${id}`, signal, fetchImpl, 'application/json')).json();
    const name = data.data?.[0]?.video;
    if (!name) throw new Error('No public video listed for this AKH item.');
    return { url: `https://api.archiv-akh.de/file/file/open/${encodeURIComponent(name)}/stream?portalId=1`, referer: url, direct: true, scope: 'whole-reel' };
  }
  if (M.isMyFootageUrl(url) && M.isClipUrl(url)) {
    if (/^\/pix\//i.test(u.pathname)) return {provider:'myfootage',url:u.href,referer:M.canonicalItemUrl(url),direct:true,scope:'whole-reel'};
    const item=M.parseClipPage(await (await get(url,signal,fetchImpl)).text(),url),hint=M.mediaHint(item);
    if(hint)return hint;
    const error=new Error('PREVIEW_UNAVAILABLE: This MyFootage clip has no public watermarked video preview.');error.code='PREVIEW_UNAVAILABLE';throw error;
  }
  if (/(^|\.)footagefarm\.com$/i.test(u.hostname) && /\/reel-details\//.test(u.pathname)) {
    const html=await (await get(url,signal,fetchImpl)).text(),candidates=[];
    for(const match of html.matchAll(/href=["']([^"']*player\.vimeo\.com\/progressive_redirect\/download\/[^"']+)["']/gi)){
      const media=webUrl(new URL(decodeHtml(match[1]),url).href);if(!media)continue;
      const context=html.slice(Math.max(0,match.index-350),match.index),dimensions=[...context.matchAll(/(\d{2,5})\s*X\s*(\d{2,5})/gi)].at(-1),size=[...context.matchAll(/([\d.]+)\s*(GB|MB)/gi)].at(-1);
      candidates.push({url:media,width:Number(dimensions?.[1]||0),height:Number(dimensions?.[2]||0),bytes:size?Number(size[1])*(size[2].toUpperCase()==='GB'?1024**3:1024**2):0});
    }
    candidates.sort((a,b)=>b.height-a.height||b.width-a.width||b.bytes-a.bytes);
    const identity = footageFarmMetadata(html);
    if(candidates.length){
      const direct = candidates.map(candidate => ({url:candidate.url,referer:url,direct:true,scope:'whole-reel',provider:'footagefarm'}));
      // Vimeo lookup is deliberately represented as an unresolved final
      // rendition. Healthy progressive downloads must not pay for a profile
      // search and oEmbed request; the downloader validates this only after all
      // advertised files have failed, including decode failures.
      const lazyVimeo = identity ? { provider: 'footagefarm-vimeo-lookup', url, referer: url, direct: false, scope: 'whole-reel', reel: identity.reel, duration: identity.duration } : null;
      return {...direct[0],alternates:[...direct.slice(1),...(lazyVimeo?[lazyVimeo]:[])]};
    }
    const vimeo = await resolveFootageFarmVimeo(identity, url, signal, fetchImpl);
    if(vimeo)return vimeo;
    // Other Vimeo iframes on the page can be private, stale, or related reels.
    // A bare player ID is not proof that it belongs to this catalog record and
    // repeatedly handing it to yt-dlp produces misleading 401 source errors.
    const error=new Error('PREVIEW_UNAVAILABLE: Footage Farm has no online screener for this catalog record. Use Request Preview on the source page.');error.code='PREVIEW_UNAVAILABLE';throw error;
  }
  return { url, direct: /\.(mp4|mov|m4v|mkv|webm|avi)(\?|$)/i.test(u.pathname), scope: 'whole-reel' };
}
function runProcess(exe, args, { signal, onLine = () => {}, timeout = 7200000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true, shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', tail = '', partial = '', settled = false;
    const abort = () => child.kill();
    const timer = setTimeout(abort, timeout);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', data => { out = (out + data.toString()).slice(-2_000_000); for (const line of data.toString().split(/[\r\n]/)) onLine(line); });
    child.stderr.on('data', data => { tail = (tail + data.toString()).slice(-5000); partial += data.toString(); const lines = partial.split(/[\r\n]/); partial = lines.pop(); for (const line of lines) onLine(line); });
    function finish(error) { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(out); }
    child.on('error', finish);
    child.on('close', code => { if (partial) onLine(partial); finish(signal?.aborted ? new Error('Preparation paused. Partial work is saved.') : code !== 0 ? new Error(`${path.basename(exe)} failed (${code}): ${tail.slice(-1200)}`) : null); });
  });
}
function renditionCandidates(resolved) {
  const { alternates = [], ...base } = resolved, candidates = [base];
  for (const alternate of alternates) candidates.push(typeof alternate === 'string' ? { ...base, url: alternate } : { ...base, ...alternate });
  const seen = new Set();
  return candidates.filter(candidate => {
    const key = `${candidate.direct !== false}:${candidate.provider || ''}:${candidate.url}`;
    if (!candidate.url || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
async function download(resolved, folder, tools, { signal, onProgress, onCandidate, onRendition, onResolved, maxBytes = 8 * 1024 ** 3 }) {
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, 'source.mp4'), candidates = renditionCandidates(resolved);
  const select = index => {
    const selected = { ...candidates[index], alternates: candidates.slice(index + 1) };
    onCandidate?.(selected.url); onRendition?.(selected);
  };
  if (await S.exists(target)) { select(0); return target; }
  let lastError;
  for (let index = 0; index < candidates.length; index++) {
    let candidate = candidates[index];
    await fs.rm(target + '.part', { force: true }).catch(() => {});
    try {
      if (candidate.provider === 'footagefarm-vimeo-lookup') {
        const fallback = await resolveFootageFarmVimeo({ reel: candidate.reel, duration: Number(candidate.duration) }, candidate.referer || candidate.url, signal, tools.resolverFetch || tools.fetch || fetch);
        if (!fallback) throw Object.assign(new Error('PREVIEW_UNAVAILABLE: No exact official Footage Farm Vimeo video matched this reel number and duration after its progressive renditions failed.'), { code: 'PREVIEW_UNAVAILABLE' });
        candidate = candidates[index] = fallback;
        // Persist this fully validated identity before authentication or yt-dlp
        // can fail. A later access retry can then resume from the exact Vimeo
        // URL without repeating the public catalog search.
        onResolved?.(fallback);
      }
      if (candidate.direct) {
        const response = await (tools.fetch || fetch)(candidate.url, { headers: { 'User-Agent': UA, ...(candidate.referer ? { Referer: candidate.referer } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(3600000)]) });
        if (!response.ok || !response.body) { const error = new Error(`Video download HTTP ${response.status}.`); error.status = response.status; throw error; }
        const total = Number(response.headers.get('content-length') || 0);
        if (total > maxBytes) { await response.body.cancel(); throw new Error('Video exceeds the per-reel download limit.'); }
        const h = await fs.open(target + '.part', 'w'); let received = 0, last = 0;
        try {
          for await (const chunk of response.body) { received += chunk.length; if (received > maxBytes) throw new Error('Video exceeds the per-reel download limit.'); await h.writeFile(chunk); if (Date.now() - last > 300) { onProgress({ bytes: received, total }); last = Date.now(); } }
          if (total && received !== total) throw new Error('Download was incomplete.');
          if (!received) throw new Error('Source returned an empty video.');
          await h.sync();
        } finally { await h.close(); }
        await fs.rename(target + '.part', target);
      } else {
        const officialFootageFarmVimeo = isOfficialFootageFarmVimeo(candidate);
        const authArgs = officialFootageFarmVimeo ? vimeoAuthArgs(await tools.getVimeoAuth?.()) : [];
        if (officialFootageFarmVimeo && !authArgs.length) throw Object.assign(new Error('Vimeo access is required for this Footage Farm screener. Choose an Edge or Chrome profile, or a Netscape cookies file, in Settings.'), { code: 'VIMEO_AUTH_REQUIRED' });
        for (const name of await fs.readdir(folder)) if (/^download\./.test(name)) await fs.rm(path.join(folder, name), { force: true });
        const execute = tools.runProcess || runProcess;
        await execute(tools.ytdlp, ['--ignore-config','--no-playlist','--no-warnings','--newline','--no-part','--force-overwrites','--no-continue','--restrict-filenames',...(candidate.referer?['--referer',candidate.referer]:[]),'--socket-timeout','30','--retries','3','--max-filesize',String(maxBytes),'--ffmpeg-location',path.dirname(tools.ffmpeg),'-f','bestvideo+bestaudio/best','--merge-output-format','mp4','-o',path.join(folder,'download.%(ext)s'),...authArgs,'--',candidate.url], { signal, onLine: line => { const m = line.match(/(\d+(?:\.\d+)?)%/); if (m) onProgress({ percent: Number(m[1]) }); } });
        const names = (await fs.readdir(folder)).filter(name => /^download\.(mp4|mkv|mov|webm|avi|m4v)$/.test(name));
        if (names.length !== 1) throw new Error('Downloader did not produce exactly one complete video.');
        await fs.rename(path.join(folder, names[0]), target);
      }
      select(index); return target;
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
      if (error.code !== 'VIMEO_AUTH_REQUIRED' && (candidate.provider === 'footagefarm' || candidate.direct && (!error.status || error.status === 429 || error.status >= 500 || /incomplete|empty video/i.test(error.message)))) error.sourceTransient = true;
    }
  }
  await fs.rm(target + '.part', { force: true }).catch(() => {});
  throw lastError || new Error('No downloadable media rendition was resolved.');
}
async function probe(file, tools, signal) {
  let data;
  try {
    data = JSON.parse(await runProcess(tools.ffprobe, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,duration,nb_frames,sample_aspect_ratio:format=duration','-of','json',file], { signal, timeout: 60000 }));
  } catch (error) {
    // A completed download that FFprobe cannot parse is a bad rendition. Keep
    // operational failures such as a missing binary distinct from media data.
    if (!['ENOENT','EPERM','EACCES'].includes(error?.code) && !signal?.aborted) error.mediaCorrupt = true;
    throw error;
  }
  const v = data.streams?.[0], duration = Number(v?.duration || data.format?.duration);
  if (!v?.width || !v?.height || !Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('Downloaded file has no readable video duration.'), { mediaCorrupt: true });
  if (duration > 6 * 3600) throw new Error('Reel exceeds six hours. Split or prepare this unusually long source manually.');
  const [sarN,sarD] = String(v.sample_aspect_ratio || '1:1').split(':').map(Number);
  return { duration, width: v.width, height: v.height, sample_aspect_ratio: sarN > 0 && sarD > 0 ? sarN / sarD : 1 };
}
function contactSheetGeometry(info, width) {
  const displayWidth = info.width * info.sample_aspect_ratio;
  if (!Number.isFinite(displayWidth) || displayWidth <= 0) throw new Error('Downloaded file has invalid display geometry.');
  // The MJPEG contact sheets use chroma-subsampled pixels. An odd scaled width
  // makes FFmpeg's pad filter round its canvas down below the input width.
  // Keep the receipt geometry exact by choosing even dimensions up front.
  const actualWidth = Math.max(2, Math.floor(Math.min(width, displayWidth) / 2) * 2);
  const height = Math.max(2, Math.ceil(info.height * actualWidth / displayWidth / 2) * 2);
  return { actualWidth, height };
}
function samplingPlan(fps) {
  if (![1,2,4].includes(fps)) throw new Error('Unsupported sampling rate.');
  if (fps === 1) return { filter: 'fps=fps=1:start_time=0:round=up:eof_action=pass', adaptive: false, baseFps: 1, maxFps: 1 };
  // Inspect candidates at the requested ceiling. A material visual change may
  // move the next sample forward, while the rolling one-second bound prevents
  // static footage from producing extra model work.
  return { filter: `fps=fps=${fps}:start_time=0:round=up:eof_action=pass,select='isnan(prev_selected_t)+gte(t-prev_selected_t,1)+gt(scene,0.05)'`, adaptive: true, baseFps: 1, maxFps: fps };
}
function coverageRange(duration,fps){return {minimum:Math.max(1,Math.floor(duration)),maximum:Math.ceil(duration*fps)};}
async function makeCards(file, folder, tools, { signal, onProgress, fps = 1, width = 960, segment_start, segment_end }) {
  if (![1,2,4].includes(fps) || ![640,960,1280].includes(width)) throw new Error('Unsupported sampling or image size.');
  const info = await probe(file, tools, signal);
  const segmented = segment_start !== undefined || segment_end !== undefined;
  const start = segmented ? segment_start : 0, end = segmented ? segment_end : info.duration;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > info.duration + .05) throw new Error('Story time range is invalid or outside the downloaded reel. Nothing published.');
  const duration = end - start;
  await fs.mkdir(folder, { recursive: true });
  const { actualWidth, height } = contactSheetGeometry(info, width);
  let frames = 0;
  const plan=samplingPlan(fps),frameTimes=[];
  const filter = jpegFullRangeFilter(`setpts=PTS-STARTPTS,${plan.filter},trim=end=${duration},showinfo,setpts=PTS+${start}/TB,scale=${actualWidth}:${height}:flags=lanczos,setsar=1,pad=iw:ih+30:0:0:color=0x151c23,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}':x=10:y=h-25:fontsize=20:fontcolor=white,tile=layout=4x4:nb_frames=16:padding=4:margin=4:color=0x151c23`);
  const rangeArgs = segmented ? ['-ss',String(start),'-t',String(duration)] : [];
  try {
    await runProcess(tools.ffmpeg, ['-hide_banner','-nostdin','-y','-xerror','-err_detect','explode',...rangeArgs,'-i',file,'-map','0:v:0','-an','-sn','-vf',filter,'-fps_mode','passthrough','-q:v','2',path.join(folder,'card_%06d.jpg')], { signal, onLine: line => { if (line.includes('Parsed_showinfo')) { const m = line.match(/\bn:\s*(\d+)/),t=line.match(/\bpts_time:\s*(-?\d+(?:\.\d+)?)/); if (m) { const index=Number(m[1]);frames=index+1;if(t)frameTimes[index]=start+Number(t[1]); if (frames % 16 === 0) onProgress({ frames, expected: plan.adaptive ? `${Math.ceil(duration)}–${Math.ceil(duration * fps)}` : Math.ceil(duration), cards: Math.ceil(frames / 16) }); } } } });
  } catch (error) { throw markCorruptMediaError(error); }
  // FFmpeg cannot synthesize a sample beyond the final decoded timestamp. For
  // fractional durations, a valid one-Hz stream may therefore contain either
  // floor(duration) or ceil(duration) samples depending on the source timebase.
  const {minimum,maximum}=coverageRange(duration,fps),cards = (await fs.readdir(folder)).filter(n => /^card_\d+\.jpg$/.test(n)).sort();
  // A discrepancy is an error, never a shorter set silently described as complete.
  if (frames < minimum || frames > maximum || frameTimes.length!==frames || cards.length !== Math.ceil(frames / 16)) throw Object.assign(new Error(`Coverage check failed: ${frames} frames / expected ${minimum}–${maximum}, ${cards.length} cards. Source needs inspection; nothing published for review.`), { mediaCorrupt: true });
  return { ...info, duration, source_duration: info.duration, ...(segmented ? {scope:'segment',segment_start:start,segment_end:end} : {}), fps, sampling:plan.adaptive?'adaptive':'fixed',base_fps:plan.baseFps,max_fps:plan.maxFps,...(plan.adaptive?{scene_threshold:.05}:{}),frame_times:frameTimes, frame_count: frames, card_count: cards.length, tile_columns: 4, tile_rows: 4, cell_width: actualWidth, cell_height: height + 30, cards: cards.map((name, i) => {const times=frameTimes.slice(i*16,i*16+16);return { name, first_frame: i * 16, frames:times.length, first_second:times[0],last_second:times.at(-1),frame_times:times};}) };
}
module.exports = { resolveMedia, runProcess, download, probe, makeCards, contactSheetGeometry, samplingPlan, coverageRange, jpegFullRangeFilter, isCorruptMediaError };
