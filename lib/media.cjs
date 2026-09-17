const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { webUrl } = require('./queue.cjs');
const S = require('./storage.cjs');
const UA = 'JewishReels/2.0 (archival footage preparation)';
const decodeHtml = s => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function get(url, signal) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]) });
      if (response.ok) return response;
      const error = new Error(`Source HTTP ${response.status} (${new URL(url).hostname}).`); error.status = response.status; last = error;
      if (response.status !== 429 && response.status < 500) throw error;
    } catch (error) {
      last = error;
      if (signal?.aborted || error.status && error.status !== 429 && error.status < 500) throw error;
    }
    if (attempt < 4) await sleep(Math.min(8000, 500 * 2 ** attempt));
  }
  // A page-level DNS/socket/timeout/429/5xx failure is not evidence that the
  // catalog record is bad. The pipeline schedules another fresh resolution so
  // Footage Farm can recover after a longer outage without manual queue edits.
  if (last) last.sourceTransient = true;
  throw last;
}
async function resolveMedia(url, signal) {
  const u = new URL(url); if (!webUrl(url)) throw new Error('Invalid video URL.');
  if (/(^|\.)filmhiradokonline\.hu$/i.test(u.hostname)) {
    const id = u.searchParams.get('id'); if (!/^\d+$/.test(id || '')) throw new Error('Hungarian item URL must include a numeric id.');
    const referer = `https://filmhiradokonline.hu/player.php?id=${id}`;
    const html = await (await get(referer, signal)).text();
    const match = html.match(/<source[^>]+src=["']([^"']+\.mp4[^"']*)["']/i);
    if (!match) throw new Error('No public MP4 source found on the Hungarian player page.');
    const media = new URL(decodeHtml(match[1]), referer).href;
    const start = Number(html.match(/var\s+start\s*=\s*(\d+(?:\.\d+)?)/i)?.[1]), end = Number(html.match(/var\s+end\s*=\s*(\d+(?:\.\d+)?)/i)?.[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Hungarian story has no valid start/end range. Refusing to substitute the entire reel.');
    return { url: media, referer, direct: true, segment_start: start, segment_end: end, scope: 'segment' };
  }
  if (/(^|\.)archiv-akh\.de$/i.test(u.hostname) && /\/filme\/(\d+)/.test(u.pathname)) {
    const id = u.pathname.match(/\/filme\/(\d+)/)[1];
    const data = await (await get(`https://api.archiv-akh.de/data/material/id/${id}`, signal)).json();
    const name = data.data?.[0]?.video;
    if (!name) throw new Error('No public video listed for this AKH item.');
    return { url: `https://api.archiv-akh.de/file/file/open/${encodeURIComponent(name)}/stream?portalId=1`, referer: url, direct: true, scope: 'whole-reel' };
  }
  if (/(^|\.)footagefarm\.com$/i.test(u.hostname) && /\/reel-details\//.test(u.pathname)) {
    const html=await (await get(url,signal)).text(),candidates=[];
    for(const match of html.matchAll(/href=["']([^"']*player\.vimeo\.com\/progressive_redirect\/download\/[^"']+)["']/gi)){
      const media=webUrl(new URL(decodeHtml(match[1]),url).href);if(!media)continue;
      const context=html.slice(Math.max(0,match.index-350),match.index),dimensions=[...context.matchAll(/(\d{2,5})\s*X\s*(\d{2,5})/gi)].at(-1),size=[...context.matchAll(/([\d.]+)\s*(GB|MB)/gi)].at(-1);
      candidates.push({url:media,width:Number(dimensions?.[1]||0),height:Number(dimensions?.[2]||0),bytes:size?Number(size[1])*(size[2].toUpperCase()==='GB'?1024**3:1024**2):0});
    }
    if(candidates.length){candidates.sort((a,b)=>b.height-a.height||b.width-a.width||b.bytes-a.bytes);return{url:candidates[0].url,referer:url,direct:true,scope:'whole-reel',provider:'footagefarm',alternates:candidates.slice(1).map(v=>v.url)};}
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
async function download(resolved, folder, tools, { signal, onProgress, maxBytes = 8 * 1024 ** 3 }) {
  await fs.mkdir(folder, { recursive: true });
  const target = path.join(folder, 'source.mp4');
  if (await S.exists(target)) return target;
  if (resolved.direct) {
    const candidates = [resolved.url, ...(resolved.alternates || [])]; let lastError;
    for (const candidate of candidates) {
      await fs.rm(target + '.part', { force: true }).catch(() => {});
      try {
        const response = await fetch(candidate, { headers: { 'User-Agent': UA, ...(resolved.referer ? { Referer: resolved.referer } : {}) }, signal: AbortSignal.any([signal, AbortSignal.timeout(3600000)]) });
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
        await fs.rename(target + '.part', target); return target;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        if (resolved.provider === 'footagefarm' || !error.status || error.status === 429 || error.status >= 500 || /incomplete|empty video/i.test(error.message)) error.sourceTransient = true;
      }
    }
    await fs.rm(target + '.part', { force: true }).catch(() => {}); throw lastError;
  }
  await runProcess(tools.ytdlp, ['--ignore-config','--no-playlist','--no-warnings','--newline','--no-part','--force-overwrites','--no-continue','--restrict-filenames',...(resolved.referer?['--referer',resolved.referer]:[]),'--socket-timeout','30','--retries','3','--max-filesize',String(maxBytes),'--ffmpeg-location',path.dirname(tools.ffmpeg),'-f','bestvideo+bestaudio/best','--merge-output-format','mp4','-o',path.join(folder,'download.%(ext)s'),'--',resolved.url], { signal, onLine: line => { const m = line.match(/(\d+(?:\.\d+)?)%/); if (m) onProgress({ percent: Number(m[1]) }); } });
  const names = (await fs.readdir(folder)).filter(n => /^download\.(mp4|mkv|mov|webm|avi|m4v)$/.test(n));
  if (names.length !== 1) throw new Error('Downloader did not produce exactly one complete video.');
  await fs.rename(path.join(folder, names[0]), target); return target;
}
async function probe(file, tools, signal) {
  const data = JSON.parse(await runProcess(tools.ffprobe, ['-v','error','-select_streams','v:0','-show_entries','stream=width,height,duration,nb_frames,sample_aspect_ratio:format=duration','-of','json',file], { signal, timeout: 60000 }));
  const v = data.streams?.[0], duration = Number(v?.duration || data.format?.duration);
  if (!v?.width || !v?.height || !Number.isFinite(duration) || duration <= 0) throw new Error('Downloaded file has no readable video duration.');
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
  const filter = `setpts=PTS-STARTPTS,${plan.filter},trim=end=${duration},showinfo,setpts=PTS+${start}/TB,scale=${actualWidth}:${height}:flags=lanczos,setsar=1,pad=iw:ih+30:0:0:color=0x151c23,drawtext=fontfile='C\\:/Windows/Fonts/consola.ttf':text='%{pts\\:hms}':x=10:y=h-25:fontsize=20:fontcolor=white,tile=layout=4x4:nb_frames=16:padding=4:margin=4:color=0x151c23`;
  const rangeArgs = segmented ? ['-ss',String(start),'-t',String(duration)] : [];
  await runProcess(tools.ffmpeg, ['-hide_banner','-nostdin','-y','-xerror','-err_detect','explode',...rangeArgs,'-i',file,'-map','0:v:0','-an','-sn','-vf',filter,'-fps_mode','passthrough','-q:v','2',path.join(folder,'card_%06d.jpg')], { signal, onLine: line => { if (line.includes('Parsed_showinfo')) { const m = line.match(/\bn:\s*(\d+)/),t=line.match(/\bpts_time:\s*(-?\d+(?:\.\d+)?)/); if (m) { const index=Number(m[1]);frames=index+1;if(t)frameTimes[index]=start+Number(t[1]); if (frames % 16 === 0) onProgress({ frames, expected: plan.adaptive ? `${Math.ceil(duration)}–${Math.ceil(duration * fps)}` : Math.ceil(duration), cards: Math.ceil(frames / 16) }); } } } });
  // FFmpeg cannot synthesize a sample beyond the final decoded timestamp. For
  // fractional durations, a valid one-Hz stream may therefore contain either
  // floor(duration) or ceil(duration) samples depending on the source timebase.
  const {minimum,maximum}=coverageRange(duration,fps),cards = (await fs.readdir(folder)).filter(n => /^card_\d+\.jpg$/.test(n)).sort();
  // A discrepancy is an error, never a shorter set silently described as complete.
  if (frames < minimum || frames > maximum || frameTimes.length!==frames || cards.length !== Math.ceil(frames / 16)) throw new Error(`Coverage check failed: ${frames} frames / expected ${minimum}–${maximum}, ${cards.length} cards. Source needs inspection; nothing published for review.`);
  return { ...info, duration, source_duration: info.duration, ...(segmented ? {scope:'segment',segment_start:start,segment_end:end} : {}), fps, sampling:plan.adaptive?'adaptive':'fixed',base_fps:plan.baseFps,max_fps:plan.maxFps,...(plan.adaptive?{scene_threshold:.05}:{}),frame_times:frameTimes, frame_count: frames, card_count: cards.length, tile_columns: 4, tile_rows: 4, cell_width: actualWidth, cell_height: height + 30, cards: cards.map((name, i) => {const times=frameTimes.slice(i*16,i*16+16);return { name, first_frame: i * 16, frames:times.length, first_second:times[0],last_second:times.at(-1),frame_times:times};}) };
}
module.exports = { resolveMedia, runProcess, download, probe, makeCards, contactSheetGeometry, samplingPlan, coverageRange };
