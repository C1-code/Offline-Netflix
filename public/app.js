const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function j(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.text()) || r.statusText);
  return r.json();
}

const fmtTime = (s) => {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};
const epTag = (s, e) => `S${String(s ?? 0).padStart(2, '0')}E${String(e ?? 0).padStart(2, '0')}`;

// ---------- routing ----------

window.addEventListener('hashchange', route);

function route() {
  const h = location.hash;
  $('#navback').hidden = h === '' || h === '#/';
  if (h.startsWith('#/t/')) renderTitle(+h.slice(4));
  else if (h.startsWith('#/w/')) openWatch(+h.slice(4));
  else if (h.startsWith('#/q/')) renderSearch(decodeURIComponent(h.slice(4)));
  else renderHome();
}

// ---------- cards ----------

function posterImg(c, cls = '') {
  if (c.poster) return `<img loading="lazy" class="${cls}" src="${esc(c.poster)}" alt="">`;
  return `<div class="ph"><span>${esc(c.name)}</span></div>`;
}

function rail(name, cards, cardHtml) {
  if (!cards || !cards.length) return '';
  return `<section class="rail"><h2>${esc(name)}</h2><div class="row">${cards.map(cardHtml).join('')}</div></section>`;
}

function titleCardHtml(c) {
  return `<div class="card" onclick="location.hash='#/t/${c.id}'">
    ${posterImg(c)}
    <div class="overlay"><div class="play"><span>&#9654;</span></div><div class="name">${esc(c.name)}${c.year ? ` <small style="color:#9a9aa5">(${c.year})</small>` : ''}</div></div>
  </div>`;
}

function cwCardHtml(c) {
  return `<div class="card" onclick="location.hash='#/w/${c.fileId}'">
    ${posterImg(c)}
    <div class="overlay"><div class="play"><span>&#9654;</span></div><div class="name">${esc(c.name)}<br><small style="color:#9a9aa5">${esc(c.label)}</small></div></div>
    <div class="progresslabel">${fmtTime(c.duration - c.position)} left</div>
    <div class="bar"><i style="width:${Math.round((c.frac || 0) * 100)}%"></i></div>
  </div>`;
}

// ---------- home ----------

async function renderHome() {
  closePlayer();
  document.title = 'Offlineflix';
  const lib = await j('/api/library');
  state.lib = lib;
  const featured = lib.continue[0] || lib.series.find((s) => s.backdrop) || lib.movies.find((m) => m.backdrop) || lib.series[0] || lib.movies[0];
  if (!featured) {
    $('#view').innerHTML = `<div class="empty">Library is empty — check config.json mediaPath, then run <code>npm run scan</code>.</div>`;
    return;
  }
  const heroKind = lib.continue[0] === featured ? 'CONTINUE WATCHING' : (featured.kind === 'series' ? 'SERIES' : 'MOVIE');
  $('#view').innerHTML = `
    <section class="hero">
      <div class="bg" style="background-image:url('${esc(featured.backdrop || featured.poster || '')}')"></div>
      <div class="shade"></div>
      <div class="content">
        <div class="kind">${heroKind}</div>
        <h1>${esc(featured.name)}</h1>
        ${featured.label ? `<div class="meta">${esc(featured.label)}</div>` : (featured.year ? `<div class="meta">${featured.year}</div>` : '')}
        ${featured.overview ? `<div class="ov">${esc(featured.overview)}</div>` : ''}
        <button class="bigbtn" onclick="location.hash='${featured.kind === 'series' || featured.kind === 'movie' ? `#/t/${featured.id}` : `#/w/${featured.fileId}`}'">&#9654; ${lib.continue[0] === featured ? 'Resume' : 'Play'}</button>
        <button class="bigbtn secondary" onclick="location.hash='#/t/${featured.id ?? featured.titleId}'">More info</button>
      </div>
    </section>
    ${rail('Continue Watching', lib.continue, cwCardHtml)}
    ${rail('Series', lib.series, titleCardHtml)}
    ${rail('Movies', lib.movies, titleCardHtml)}
  `;
}

// ---------- search ----------

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const term = e.target.value.trim();
  searchTimer = setTimeout(() => {
    if (term) renderSearch(term);
    else route();
  }, 250);
});

async function renderSearch(term) {
  closePlayer();
  document.title = `Search: ${term}`;
  const { results } = await j('/api/search?q=' + encodeURIComponent(term));
  $('#view').innerHTML = results.length
    ? `<div class="searchgrid">${results.map(titleCardHtml).join('')}</div>`
    : `<div class="empty">No results for “${esc(term)}”</div>`;
}

// ---------- state ----------

const state = { lib: null };

// ---------- title detail ----------

const SUB_BADGE = (f) => f.subCount > 0
  ? `<span class="badge ok">CC · ${f.subCount} track${f.subCount > 1 ? 's' : ''}</span>`
  : ({ pending: `<span class="badge">no subs</span>`,
       waiting: `<span class="badge wait">AI queued…</span>`,
       transcribing: `<span class="badge wait">AI transcribing…</span>`,
       failed: `<span class="badge">AI failed</span>`,
       done: `<span class="badge">done</span>` }[f.subStatus] || '');

function epRow(f) {
  const line = f.kind === 'episode'
    ? `<span class="num">${epTag(f.season, f.episode)}</span> <b>${esc(f.epName || '')}</b> ${SUB_BADGE(f)}`
    : `<b>${esc(f.epName || 'Featurette')}</b> ${SUB_BADGE(f)}`;
  return `<div class="ep" onclick="location.hash='#/w/${f.id}'">
    <div class="still">${f.still ? `<img loading="lazy" src="${esc(f.still)}">` : ''}<div class="pl">&#9654;</div></div>
    <div class="body">
      <div class="epline">${line}<span class="dur">${f.duration ? fmtTime(f.duration) : ''}${f.frac > 0 && f.frac < 1 ? ` · ${fmtTime(f.duration - f.position)} left` : ''}</span></div>
      ${f.epOverview ? `<div class="ov">${esc(f.epOverview)}</div>` : ''}
      ${f.frac > 0 ? `<div class="bar"><i style="width:${Math.round(f.frac * 100)}%"></i></div>` : ''}
    </div>
  </div>`;
}

async function renderTitle(id) {
  closePlayer();
  const d = await j('/api/title/' + id);
  const t = d.title;
  document.title = t.name;
  const playable = d.files.filter((f) => f.kind !== 'extra');
  const resume = playable.find((f) => f.frac > 0.02 && f.frac < 0.97) || playable[0];
  const seasons = new Map();
  const extras = [];
  for (const f of d.files) {
    if (f.kind === 'extra') extras.push(f);
    else if (!seasons.has(f.season)) seasons.set(f.season, [f]);
    else seasons.get(f.season).push(f);
  }
  const seasonHtml = [...seasons.keys()].sort((a, b) => a - b).map((s) => {
    const eps = seasons.get(s).sort((a, b) => a.episode - b.episode);
    return `<div class="seasonsec"><h3>Season ${s}</h3>${eps.map(epRow).join('')}</div>`;
  }).join('');
  const extrasHtml = extras.length
    ? `<div class="seasonsec"><h3>Extras</h3>${extras.map(epRow).join('')}</div>` : '';
  $('#view').innerHTML = `
    <section class="detail-hero">
      ${t.backdrop || resume?.still ? `<div class="bg" style="background-image:url('${esc(t.backdrop || resume.still)}')"></div><div class="shade"></div>` : ''}
      <div class="inner">
        ${t.poster ? `<img class="poster" src="${esc(t.poster)}">` : ''}
        <div class="info">
          <h1>${esc(t.name)}${t.year ? ` <span style="color:var(--dim);font-weight:400;font-size:22px">(${t.year})</span>` : ''}</h1>
          <div class="meta">${t.kind === 'series' ? 'SERIES' : 'MOVIE'}${t.overview ? '' : ' · metadata not synced (add TMDB key, run npm run tmdb:sync)'}</div>
          ${t.overview ? `<div class="ov">${esc(t.overview)}</div>` : ''}
          <button class="bigbtn" onclick="location.hash='#/w/${resume?.id}'">&#9654; ${resume && resume.frac > 0.02 ? 'Resume' : 'Play'}</button>
        </div>
      </div>
    </section>
    ${t.kind === 'series' ? seasonHtml + extrasHtml : ''}
  `;
}

// ---------- player ----------

let P = null;
const video = () => $('#video');

const SETTINGS_KEY = 'oflix-settings';
let settings = { volume: 1, muted: false, rate: 1, subSize: 'md', autoplayNext: true };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch {}
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

const GOOD_VCODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1', 'mpeg4', 'mpeg2video'];
const GOOD_ACODECS = ['aac', 'mp3', 'mp2', 'opus', 'flac', 'vorbis', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'];

const displayTime = () => video().currentTime + (P && P.mode !== 'native' && P.timeOffset ? P.timeOffset : 0);

// Learned modes: which playback mode actually worked per codec combo.
const MODE_LEARN_KEY = 'oflix-mode-learn';
function learnMap() { try { return JSON.parse(localStorage.getItem(MODE_LEARN_KEY) || '{}'); } catch { return {}; } }
function learnMode(file, mode) {
  const m = learnMap();
  const k = (file.vcodec || '') + '|' + (file.acodec || '');
  if (m[k] !== mode) { m[k] = mode; localStorage.setItem(MODE_LEARN_KEY, JSON.stringify(m)); }
}

function msOK(codecStr) {
  try { return !!window.MediaSource && !!codecStr && MediaSource.isTypeSupported('video/mp4; codecs="' + codecStr + '"'); }
  catch { return false; }
}

// Mode preference order, capability-driven:
//   native   — browser decodes the file as-is
//   remux    — video passthrough (fMP4+MSE), audio copied or -> AAC
//   transcode— full CPU re-encode to H.264/AAC
function modeChain(file) {
  const v = file.vcodec || '', a = file.acodec || '';
  const learned = learnMap()[v + '|' + a];
  let first = null;
  if (learned) first = learned;
  else if (GOOD_ACODECS.includes(a) && GOOD_VCODECS.includes(v)) first = 'native';
  else if (GOOD_VCODECS.includes(v) && msOK(file.vcodec_str) && msOK('mp4a.40.2')) first = 'remux';
  else first = 'transcode';
  return [first, ...['native', 'remux', 'transcode'].filter((m) => m !== first)];
}

function hideMenus() {
  $('#subsmenu').hidden = true;
  $('#speedmenu').hidden = true;
  $('#epspanel').hidden = true;
}

function closePlayer() {
  if (!P) return;
  saveProgressNow();
  clearInterval(P.saveTimer);
  clearInterval(P.nextTimer);
  clearTimeout(P.watchdog);
  destroyMSE();
  const v = video();
  v.pause();
  v.removeAttribute('src');
  try { v.load(); } catch {}
  $('#player').hidden = true;
  hideMenus();
  $('#nextoverlay').hidden = true;
  $('#subsbox').innerHTML = '';
  P = null;
}

function destroyMSE() {
  if (P && P.mse) {
    try { P.mse.stop(); } catch {}
    P.mse = null;
  }
}

function initialStart() {
  const p = P.data.progress;
  if (p.position > 15 && p.duration && p.position / p.duration < 0.97) return Math.floor(p.position);
  return 0;
}

async function openWatch(fileId) {
  const d = await j('/api/file/' + fileId);
  if (P) closePlayer();
  P = { fileId, data: d, saveTimer: null, nextTimer: null, watchdog: null,
        modes: modeChain(d.file), modeIdx: 0, mode: null, mse: null,
        timeOffset: 0, cues: null, activeSub: -2, lastCue: undefined, subCache: {} };
  P.mode = P.modes[0];
  $('#player').hidden = false;
  hideMenus();
  $('#nextoverlay').hidden = true;
  const v = video();
  v.volume = settings.volume;
  v.muted = settings.muted;
  v.playbackRate = settings.rate;
  $('#vol').value = Math.round(settings.volume * 100);
  $('#btn-speed').innerHTML = settings.rate + '&times;';
  $('#subsbox').className = 'sub-' + settings.subSize;
  attachPlayback(initialStart());
  v.addEventListener('ended', onEnded);
  v.addEventListener('timeupdate', updateSeekUI);
  v.addEventListener('pause', () => { showControls(); saveProgressNow(); });
  P.saveTimer = setInterval(saveProgressNow, 4000);
  setSubTrack(P.data.subtracks.length ? 0 : -1);
  renderNowPlaying();
}

function attachPlayback(startAt) {
  destroyMSE();
  const v = video();
  const resume = startAt || 0;
  const f = P.data.file;
  if (P.mode === 'native') {
    P.timeOffset = 0;
    v.src = `/stream/${P.fileId}`;
    v.addEventListener('loadedmetadata', () => {
      if (resume > 0) v.currentTime = resume;
      v.play().catch(() => {});
    }, { once: true });
  } else if (P.mode === 'remux') {
    P.timeOffset = resume;
    const acopy = msOK(f.acodec_str) && ['eac3', 'ac3', 'mp3'].includes(f.acodec || '') ? 1 : 0;
    const codecs = acopy ? `${f.vcodec_str},${f.acodec_str}` : `${f.vcodec_str},mp4a.40.2`;
    const url = `/stream/${P.fileId}?audio=1${acopy ? '&acopy=1' : ''}${resume ? `&start=${resume}` : ''}`;
    P.mse = new Fmp4MsePlayer(v, url, codecs, (e) => playbackFailed('MSE: ' + (e?.message || e)));
    P.mse.start();
    v.play().catch(() => {});
  } else { // transcode
    P.timeOffset = resume;
    v.src = `/stream/${P.fileId}?transcode=1${resume ? `&start=${resume}` : ''}`;
    v.addEventListener('loadedmetadata', () => { v.play().catch(() => {}); }, { once: true });
  }
  armWatchdog();
}

// If a mode produces nothing, fall through to the next one automatically.
function armWatchdog() {
  clearTimeout(P.watchdog);
  P.watchdog = setTimeout(() => {
    if (P && video().readyState < 2) playbackFailed('no media data in 12s');
  }, 12000);
}

function playbackFailed(reason) {
  if (!P || P.failing) return;
  P.failing = true;
  console.warn('[playback] mode', P.mode, 'failed:', reason);
  P.modeIdx += 1;
  if (P.modeIdx >= P.modes.length) {
    $('#nowplaying').textContent = 'No playback mode worked for this file (see server.log)';
    showControls();
    return;
  }
  P.mode = P.modes[P.modeIdx];
  P.failing = false;
  P.lastCue = undefined;
  flashSubs('Switching to ' + P.mode + ' playback…');
  attachPlayback(Math.max(0, Math.floor(displayTime())));
}

function renderNowPlaying() {
  const d = P.data;
  $('#nowplaying').innerHTML =
    `<b>${esc(d.title.name)}</b>` +
    (d.file.kind === 'episode'
      ? ` <span>${epTag(d.file.season, d.file.episode)} · ${esc(d.file.epName || '')}</span>`
      : '');
}

// ---------- fMP4 over MSE (video passthrough remux) ----------

class Fmp4MsePlayer {
  constructor(video, url, codecs, onError) {
    this.video = video; this.url = url; this.codecs = codecs; this.onError = onError;
    this.stopped = false; this.mse = null; this.sb = null; this.reader = null;
  }
  start() {
    (async () => {
      try {
        this.mse = new MediaSource();
        this.objUrl = URL.createObjectURL(this.mse);
        this.video.src = this.objUrl;
        await this.once(this.mse, 'sourceopen', 5000);
        this.sb = this.mse.addSourceBuffer('video/mp4; codecs="' + this.codecs + '"');
        this.sb.mode = 'sequence';
        const res = await fetch(this.url);
        if (!res.ok || !res.body) throw new Error('stream HTTP ' + res.status);
        this.reader = res.body.getReader();
        await this.pump();
        if (!this.stopped) { try { this.mse.endOfStream(); } catch {} }
      } catch (e) { if (!this.stopped) this.fail(e); }
    })();
  }
  once(target, ev, timeout) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeout);
      target.addEventListener(ev, () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  fail(e) { if (this.stopped) return; this.stopped = true; if (this.onError) this.onError(e); }
  stop() {
    this.stopped = true;
    try { this.reader && this.reader.cancel(); } catch {}
    try { this.mse && this.mse.readyState !== 'closed' && this.mse.endOfStream(); } catch {}
    try { this.objUrl && URL.revokeObjectURL(this.objUrl); } catch {}
  }
  bufferedAhead() {
    const v = this.video;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.end(i) > end) end = v.buffered.end(i);
    return end - v.currentTime;
  }
  append(buf) {
    return new Promise((resolve) => {
      const sb = this.sb;
      const cleanup = () => { sb.removeEventListener('updateend', done); sb.removeEventListener('error', err); };
      const done = () => { cleanup(); resolve(); };
      const err = () => { cleanup(); this.fail(new Error('MSE append failed')); };
      sb.addEventListener('updateend', done, { once: true });
      sb.addEventListener('error', err, { once: true });
      try { sb.appendBuffer(buf); } catch (e) { cleanup(); this.fail(e); }
    });
  }
  async pump() {
    const concat = (a, b) => { const c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; };
    let acc = new Uint8Array(0), init = [], initDone = false, seg = [], stopped = () => this.stopped;
    for (;;) {
      if (stopped()) return;
      if (this.bufferedAhead() > 30) { await new Promise((r) => setTimeout(r, 250)); continue; }
      const { value, done } = await this.reader.read();
      if (value && value.length) acc = concat(acc, value);
      let progressed = true;
      while (progressed && acc.length >= 8) {
        progressed = false;
        const size = ((acc[0] << 24) | (acc[1] << 16) | (acc[2] << 8) | acc[3]) >>> 0;
        const type = String.fromCharCode(acc[4], acc[5], acc[6], acc[7]);
        if (size === 0 || acc.length < size) break;
        const box = acc.slice(0, size);
        acc = acc.slice(size);
        progressed = true;
        if (!initDone) {
          init.push(box);
          if (type === 'moov') { initDone = true; await this.append(init); init = []; }
        } else if (type === 'moof') {
          if (seg.length) await this.append(seg);
          seg = [box];
        } else if (seg.length) {
          seg.push(box);
          if (type === 'mdat') { await this.append(seg); seg = []; }
        }
      }
      if (done) { if (seg.length) await this.append(seg); break; }
    }
  }
}

// ---------- custom subtitle renderer ----------

function parseVTT(text) {
  const cues = [];
  const toS = (h, m, s, ms) => (h ? +h * 3600 : 0) + +m * 60 + +s + +('0.' + ms);
  const re = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})/;
  for (const raw of (text || '').split(/\r?\n/)) {
    const m = raw.match(re);
    if (m) cues.push({ start: toS(m[1], m[2], m[3], m[4]), end: toS(m[5], m[6], m[7], m[8]), text: [] });
    else if (cues.length && raw.trim() && !/^WEBVTT/i.test(raw) && !/^\d+$/.test(raw.trim())) {
      cues[cues.length - 1].text.push(raw.trim());
    }
  }
  return cues.filter((c) => c.text.length);
}

async function setSubTrack(i) {
  hideMenus();
  if (!P) return;
  if (i < 0 || !P.data.subtracks[i]) { P.cues = null; P.activeSub = -1; $('#subsbox').innerHTML = ''; flashSubs('Subtitles off'); return; }
  P.activeSub = i;
  const id = P.data.subtracks[i].id;
  if (!P.subCache[id]) {
    try {
      const res = await fetch('/subtitle/' + id);
      if (!res.ok) throw new Error(res.status);
      P.subCache[id] = parseVTT(await res.text());
    } catch { flashSubs('Subtitle failed to load'); return; }
  }
  P.cues = P.subCache[id];
  P.lastCue = undefined;
  const src = P.data.subtracks[i].source;
  flashSubs(`Subtitles: ${P.data.subtracks[i].label}${src === 'whisper' ? ' (AI)' : ''}`);
}

function subLoop() {
  if (P && P.cues) {
    const t = displayTime();
    const cue = P.cues.find((c) => t >= c.start && t <= c.end) || null;
    if (cue !== P.lastCue) {
      P.lastCue = cue;
      $('#subsbox').innerHTML = cue ? cue.text.map(esc).join('<br>') : '';
    }
  }
  requestAnimationFrame(subLoop);
}
requestAnimationFrame(subLoop);

// ---------- progress ----------

function saveProgressNow() {
  if (!P) return;
  const v = video();
  const pos = displayTime();
  const dur = P.data.file.duration || 0;
  if (!dur || pos < 3) return;
  const body = JSON.stringify({ fileId: P.fileId, position: pos, duration: dur });
  try {
    navigator.sendBeacon('/api/progress', new Blob([body], { type: 'application/json' }));
  } catch {
    fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true });
  }
}
window.addEventListener('pagehide', saveProgressNow);

function updateSeekUI() {
  const v = video();
  if (!v.duration) return;
  const t = displayTime();
  $('#seek').value = Math.min(1000, Math.round((t / v.duration) * 1000));
  $('#timecur').textContent = fmtTime(t);
  $('#timetot').textContent = fmtTime(v.duration);
  const nearEnd = P?.data.nextId != null && v.duration - v.currentTime < 120;
  $('#btn-next').hidden = !nearEnd;
  if (!nearEnd && !$('#nextoverlay').hidden) {
    $('#nextoverlay').hidden = true;
    clearInterval(P?.nextTimer);
  }
}

function onEnded() {
  saveProgressNow();
  if (!P?.data.nextId) return;
  if (!settings.autoplayNext) { location.hash = `#/t/${P.data.title.id}`; return; }
  const d = P.data;
  fetch(`/api/file/${d.nextId}`).then((r) => r.json()).then((nx) => {
    $('#nextname').textContent = `${d.title.name} — ${nx.file.epName || epTag(nx.file.season, nx.file.episode)}`;
  });
  $('#nextoverlay').hidden = false;
  let left = 10;
  $('#nextlabel').textContent = `Up next in ${left}`;
  clearInterval(P.nextTimer);
  P.nextTimer = setInterval(() => {
    $('#nextlabel').textContent = `Up next in ${--left}`;
    if (left <= 0) { clearInterval(P.nextTimer); location.hash = `#/w/${d.nextId}`; }
  }, 1000);
}

// ---------- controls & widgets ----------

function showControls() {
  $('#controls').classList.remove('hidden');
  $('#nowplaying').classList.remove('hidden');
  clearTimeout(P?.hideTimer);
  if (P) P.hideTimer = setTimeout(() => {
    if (!video().paused) {
      $('#controls').classList.add('hidden');
      $('#nowplaying').classList.add('hidden');
    }
  }, 3000);
}

video().addEventListener('click', () => { const v = video(); v.paused ? v.play() : v.pause(); });
video().addEventListener('dblclick', toggleFs);
$('#player').addEventListener('mousemove', showControls);
$('#player').addEventListener('touchstart', showControls);

$('#btn-play').addEventListener('click', () => { const v = video(); v.paused ? v.play() : v.pause(); showControls(); });
video().addEventListener('play', () => { $('#btn-play').innerHTML = '&#10074;&#10074;'; showControls(); });
video().addEventListener('pause', () => { $('#btn-play').innerHTML = '&#9654;'; });
video().addEventListener('playing', () => {
  clearTimeout(P?.watchdog);            // data is flowing — cancel the fallback watchdog
  if (P) learnMode(P.data.file, P.mode);
});
video().addEventListener('error', () => {
  if (P) playbackFailed('media error ' + (video().error?.code || ''));
});

$('#seek').addEventListener('input', (e) => {
  const v = video();
  if (!v.duration) return;
  const target = (e.target.value / 1000) * v.duration;
  if (P && P.mode !== 'native') {       // remux/transcode: restart the stream at the target
    attachPlayback(Math.max(0, Math.floor(target)));
  } else {
    v.currentTime = target;
  }
  showControls();
});

function setVolume(vol, muted) {
  settings.volume = vol; settings.muted = muted;
  const v = video();
  v.volume = vol; v.muted = muted;
  $('#vol').value = Math.round(vol * 100);
  $('#btn-mute').innerHTML = muted || vol === 0 ? '&#128263;' : (vol > 0.5 ? '&#128266;' : '&#128265;');
  saveSettings();
}
$('#vol').addEventListener('input', (e) => setVolume(e.target.value / 100, false));
$('#btn-mute').addEventListener('click', () => setVolume(settings.volume, !settings.muted));

$('#btn-subs').addEventListener('click', () => {
  $('#speedmenu').hidden = true; $('#epspanel').hidden = true;
  const m = $('#subsmenu');
  m.hidden = !m.hidden;
  if (!m.hidden) buildSubsMenu();
});

function buildSubsMenu() {
  const m = $('#subsmenu');
  let items = `<div class="item ${P.activeSub === -1 ? 'sel' : ''}" data-i="-1">Off</div>`;
  P.data.subtracks.forEach((s, i) => {
    const label = s.label + (s.source === 'whisper' ? ' (AI)' : '');
    items += `<div class="item ${P.activeSub === i ? 'sel' : ''}" data-i="${i}">${esc(label)} <span class="src">${esc(s.source)}</span></div>`;
  });
  if (!P.data.subtracks.length) {
    items += `<div class="item" id="gen-sub">Generate with AI (Whisper) <span class="src">GPU</span></div>`;
  }
  items += `<div class="menusec">Text size</div>`;
  for (const [k, lbl] of [['sm', 'Small'], ['md', 'Medium'], ['lg', 'Large']]) {
    items += `<div class="item ${settings.subSize === k ? 'sel' : ''}" data-size="${k}">${lbl}</div>`;
  }
  m.innerHTML = items;
  m.querySelectorAll('.item').forEach((el) => el.addEventListener('click', async () => {
    if (el.dataset.size) {
      settings.subSize = el.dataset.size;
      $('#subsbox').className = 'sub-' + settings.subSize;
      saveSettings(); buildSubsMenu(); return;
    }
    if (el.id === 'gen-sub') return generateSubs();
    await setSubTrack(+el.dataset.i);
    buildSubsMenu();
  }));
}

async function generateSubs() {
  hideMenus();
  await j('/api/subtitles/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: P.fileId }) });
  flashSubs('Whisper queued — subtitles appear when finished');
  const poll = setInterval(async () => {
    const qs = await j('/api/queue');
    if (!qs.subs.some((r) => r.s === 'transcribing' || r.s === 'waiting')) {
      clearInterval(poll);
      const d = await j('/api/file/' + P.fileId);
      P.data = d;
      P.subCache = {};
      if (d.subtracks.length) await setSubTrack(0);
    }
  }, 5000);
}

$('#btn-speed').addEventListener('click', () => {
  $('#subsmenu').hidden = true; $('#epspanel').hidden = true;
  const m = $('#speedmenu');
  m.hidden = !m.hidden;
  if (!m.hidden) buildSpeedMenu();
});
function buildSpeedMenu() {
  const m = $('#speedmenu');
  m.innerHTML = [0.5, 0.75, 1, 1.25, 1.5, 2].map((r) =>
    `<div class="item ${settings.rate === r ? 'sel' : ''}" data-r="${r}">${r}&times;</div>`
  ).join('') + `<div class="menusec">Playback</div>
    <div class="item ${settings.autoplayNext ? 'sel' : ''}" id="auto-next">Autoplay next ${settings.autoplayNext ? '&#10003;' : ''}</div>`;
  m.querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => {
    if (el.id === 'auto-next') {
      settings.autoplayNext = !settings.autoplayNext;
      saveSettings(); buildSpeedMenu(); return;
    }
    settings.rate = +el.dataset.r;
    video().playbackRate = settings.rate;
    $('#btn-speed').innerHTML = settings.rate + '&times;';
    saveSettings(); hideMenus();
  }));
}

$('#btn-eps').addEventListener('click', async () => {
  $('#subsmenu').hidden = true; $('#speedmenu').hidden = true;
  const m = $('#epspanel');
  if (!m.hidden) { m.hidden = true; return; }
  const d = await j('/api/title/' + P.data.title.id);
  const seasons = new Map();
  for (const f of d.files.filter((x) => x.kind !== 'extra')) {
    if (!seasons.has(f.season)) seasons.set(f.season, []);
    seasons.get(f.season).push(f);
  }
  let html = '';
  for (const s of [...seasons.keys()].sort((a, b) => a - b)) {
    html += `<div class="menusec">Season ${s}</div>`;
    for (const f of seasons.get(s).sort((a, b) => a.episode - b.episode)) {
      html += `<div class="item ${f.id === P.fileId ? 'sel' : ''}" data-fid="${f.id}">${epTag(f.season, f.episode)} · ${esc(f.epName || '')}</div>`;
    }
  }
  m.innerHTML = html;
  m.querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => {
    location.hash = '#/w/' + el.dataset.fid;
  }));
});

$('#btn-back').addEventListener('click', () => {
  const t = P?.data.title;
  location.hash = t && t.kind === 'series' ? `#/t/${t.id}` : '#/';
});
$('#btn-fs').addEventListener('click', toggleFs);
$('#btn-compat').addEventListener('click', () => {
  if (!P) return;
  const wasCompat = P.mode === 'transcode';
  P.mode = wasCompat ? P.modes[0] : 'transcode';
  P.modeIdx = P.modes.indexOf(P.mode);
  $('#btn-compat').classList.toggle('on', P.mode === 'transcode');
  attachPlayback(Math.max(0, Math.floor(displayTime())));
  flashSubs(P.mode === 'transcode' ? 'Compat: full CPU re-encode (may buffer on 4K)' : 'Back to auto mode: ' + P.mode);
});

$('#btn-startnext').addEventListener('click', () => { if (P?.data.nextId) location.hash = `#/w/${P.data.nextId}`; });
$('#nextoverlay').addEventListener('click', (e) => {
  if (e.target.id === 'nextoverlay') { $('#nextoverlay').hidden = true; clearInterval(P?.nextTimer); }
});

function flashSubs(msg) {
  const el = $('#subsflash');
  el.textContent = msg;
  el.style.opacity = 1;
  setTimeout(() => (el.style.opacity = 0), 1800);
}

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

document.addEventListener('keydown', (e) => {
  if (!P || $('#player').hidden) return;
  const v = video();
  switch (e.key) {
    case ' ': case 'k': e.preventDefault(); v.paused ? v.play() : v.pause(); break;
    case 'ArrowRight': v.currentTime += 10; break;
    case 'ArrowLeft': v.currentTime = Math.max(0, v.currentTime - 10); break;
    case 'ArrowDown': setVolume(Math.max(0, settings.volume - 0.1), false); break;
    case 'ArrowUp': setVolume(Math.min(1, settings.volume + 0.1), false); break;
    case 'f': toggleFs(); break;
    case 'm': setVolume(settings.volume, !settings.muted); break;
    case 'c': $('#btn-subs').click(); break;
    case 'n': if (P.data.nextId) location.hash = `#/w/${P.data.nextId}`; break;
    case 'Escape': hideMenus(); $('#btn-back').click(); break;
  }
  showControls();
});

$('#navback').addEventListener('click', () => (location.hash = '#/'));
$('#logo').addEventListener('click', () => (location.hash = '#/'));

// ---------- boot ----------
route();
