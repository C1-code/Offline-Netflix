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

function closePlayer() {
  if (!P) return;
  saveProgressNow();
  clearInterval(P.saveTimer);
  clearTimeout(P.nextTimer);
  const v = video();
  v.pause();
  v.removeAttribute('src');
  v.load();
  $('#player').hidden = true;
  $('#nextoverlay').hidden = true;
  $('#subsmenu').hidden = true;
  P = null;
}

async function openWatch(fileId) {
  const d = await j('/api/file/' + fileId);
  if (P) { closePlayer(); }
  P = { fileId, data: d, saveTimer: null, nextTimer: null, compat: false };
  $('#player').hidden = false;
  $('#nextoverlay').hidden = true;
  $('#subsmenu').hidden = true;
  const v = video();
  v.src = `/stream/${fileId}`;
  buildSubTracks(d);
  const p = d.progress;
  v.addEventListener('loadedmetadata', () => {
    if (p.position > 15 && p.duration && p.position / p.duration < 0.97) v.currentTime = p.position;
    v.play().catch(() => {});
  }, { once: true });
  v.addEventListener('ended', onEnded);
  v.addEventListener('timeupdate', () => updateSeekUI());
  v.addEventListener('pause', () => { showControls(); saveProgressNow(); });
  P.saveTimer = setInterval(saveProgressNow, 4000);
  $('#btn-compat').classList.toggle('on', false);
  updateSeekUI();
}

function buildSubTracks(d) {
  const v = video();
  for (const el of [...v.querySelectorAll('track')]) el.remove();
  P.subtracks = d.subtracks;
  const parts = d.subtracks.map((s) => {
    const label = s.label + (s.source === 'whisper' ? ' (AI)' : s.source === 'embedded' ? ' (embedded)' : '');
    return `<track kind="subtitles" src="/subtitle/${s.id}" srclang="${esc(s.lang || 'en')}" label="${esc(label)}">`;
  });
  v.insertAdjacentHTML('beforeend', parts.join(''));
  // default: first track on
  setTimeout(() => {
    const tt = v.textTracks;
    if (tt.length) { tt[0].mode = 'showing'; flashSubs(`Subtitles: ${tt.length > 1 ? tt.length + ' tracks' : d.subtracks[0].label}`); }
    else $('#substatus').textContent = 'no subtitles';
    buildSubsMenu();
  }, 300);
}

function flashSubs(msg) {
  const el = $('#subsflash');
  el.textContent = msg;
  el.style.opacity = 1;
  setTimeout(() => (el.style.opacity = 0), 1600);
}

function buildSubsMenu() {
  const menu = $('#subsmenu');
  const tracks = video().textTracks;
  let items = `<div class="item ${!tracks.length || [...tracks].every((t) => t.mode !== 'showing') ? 'sel' : ''}" data-i="-1">Off</div>`;
  P.data.subtracks.forEach((s, i) => {
    const label = s.label + (s.source === 'whisper' ? ' (AI)' : '');
    items += `<div class="item ${tracks[i]?.mode === 'showing' ? 'sel' : ''}" data-i="${i}">${esc(label)} <span class="src">${esc(s.source)}</span></div>`;
  });
  if (!P.data.subtracks.length) {
    items += `<div class="item" id="gen-sub">Generate with AI (Whisper) <span class="src">GPU</span></div>`;
  }
  menu.innerHTML = items;
  menu.querySelectorAll('.item').forEach((el) => el.addEventListener('click', () => {
    const i = el.dataset.i;
    if (el.id === 'gen-sub') return generateSubs();
    [...tracks].forEach((t, j) => (t.mode = j === +i ? 'showing' : 'disabled'));
    menu.hidden = true;
    flashSubs(i === '-1' ? 'Subtitles off' : 'Subtitles: ' + P.data.subtracks[+i].label);
  }));
}

async function generateSubs() {
  $('#substatus').textContent = 'AI transcribing…';
  await j('/api/subtitles/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: P.fileId }) });
  flashSubs('Whisper queued — subtitles will appear when finished');
  $('#subsmenu').hidden = true;
  const poll = setInterval(async () => {
    const qs = await j('/api/queue');
    const row = qs.subs.find((r) => r.s === 'transcribing' || r.s === 'waiting');
    if (!row) {
      clearInterval(poll);
      const d = await j('/api/file/' + P.fileId);
      if (d.subtracks.length) {
        P.data = d;
        buildSubTracks(d);
        $('#substatus').textContent = '';
      }
    }
  }, 5000);
}

// ---------- progress ----------

function saveProgressNow() {
  if (!P) return;
  const v = video();
  const pos = v.currentTime || 0;
  const dur = v.duration || P.data.file.duration || 0;
  if (!dur || pos < 3) return;
  navigator.sendBeacon('/api/progress', new Blob(
    [JSON.stringify({ fileId: P.fileId, position: pos, duration: dur })],
    { type: 'application/json' }
  ));
}
window.addEventListener('pagehide', saveProgressNow);

function updateSeekUI() {
  const v = video();
  if (!v.duration) return;
  $('#seek').value = Math.round((v.currentTime / v.duration) * 1000);
  $('#timecur').textContent = fmtTime(v.currentTime);
  $('#timetot').textContent = fmtTime(v.duration);
  const nearEnd = P.data.nextId != null && v.duration - v.currentTime < 120;
  $('#btn-next').hidden = !nearEnd;
  if (!nearEnd && !$('#nextoverlay').hidden) {
    // defensive: never show "up next" while playback is mid-stream
    $('#nextoverlay').hidden = true;
    clearInterval(P.nextTimer);
    P.nextShown = false;
  }
}

function onEnded() {
  saveProgressNow();
  if (!P?.data.nextId) return;
  const d = P.data;
  $('#nextname').textContent = d.title.name + (d.file.kind === 'episode' ? ` — ${epTag(d.file.season + 1, 1)}` : '');
  $('#nextoverlay').hidden = false;
  fetch(`/api/file/${d.nextId}`).then((r) => r.json()).then((nx) => {
    $('#nextname').textContent = `${d.title.name} — ${nx.file.epName || epTag(nx.file.season, nx.file.episode)}`;
  });
  let left = 10;
  P.nextTimer = setInterval(() => {
    $('#nextlabel').textContent = `Up next in ${--left}`;
    if (left <= 0) { clearInterval(P.nextTimer); location.hash = `#/w/${d.nextId}`; }
  }, 1000);
}

// ---------- controls ----------

function showControls() {
  $('#controls').classList.remove('hidden');
  clearTimeout(P?.hideTimer);
  if (P) P.hideTimer = setTimeout(() => {
    if (!video().paused) $('#controls').classList.add('hidden');
  }, 3000);
}

$('#video').addEventListener('click', () => {
  const v = video();
  v.paused ? v.play() : v.pause();
});
$('#video').addEventListener('dblclick', () => toggleFs());
$('#player').addEventListener('mousemove', showControls);
$('#player').addEventListener('touchstart', showControls);

$('#btn-play').addEventListener('click', () => {
  const v = video();
  v.paused ? v.play() : v.pause();
  showControls();
});
video().addEventListener('play', () => { $('#btn-play').innerHTML = '&#10074;&#10074;'; showControls(); });
video().addEventListener('pause', () => { $('#btn-play').innerHTML = '&#9654;'; });
video().addEventListener('playing', () => { $('#substatus').textContent = ''; });
video().addEventListener('error', () => {
  if (!P) return;
  $('#substatus').textContent = 'playback error';
  if (!P.compat) flashSubs('Cannot decode this file — press Compat mode');
});

$('#seek').addEventListener('input', (e) => {
  const v = video();
  if (v.duration) v.currentTime = (e.target.value / 1000) * v.duration;
});

$('#btn-back').addEventListener('click', () => {
  const t = P?.data.title;
  location.hash = t && t.kind === 'series' ? `#/t/${t.id}` : '#/';
});
$('#btn-subs').addEventListener('click', () => {
  const m = $('#subsmenu');
  m.hidden = !m.hidden;
  if (!m.hidden) buildSubsMenu();
});
$('#btn-fs').addEventListener('click', toggleFs);

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

$('#btn-compat').addEventListener('click', () => {
  if (!P) return;
  P.compat = !P.compat;
  $('#btn-compat').classList.toggle('on', P.compat);
  const v = video();
  const t = v.currentTime;
  v.src = `/stream/${P.fileId}${P.compat ? '?transcode=1' : ''}`;
  v.addEventListener('loadedmetadata', () => { v.currentTime = t; v.play().catch(() => {}); }, { once: true });
  flashSubs(P.compat ? 'Compatibility mode: GPU re-encode (no seeking)' : 'Direct play');
});

$('#btn-startnext').addEventListener('click', () => {
  if (P?.data.nextId) location.hash = `#/w/${P.data.nextId}`;
});

$('#nextoverlay').addEventListener('click', (e) => {
  if (e.target.id === 'nextoverlay') {
    $('#nextoverlay').hidden = true;
    clearInterval(P?.nextTimer);
  }
});

// keyboard
document.addEventListener('keydown', (e) => {
  if (P && $('#player').hidden === false) {
    const v = video();
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (e.key === 'ArrowRight') v.currentTime = Math.min(v.duration || 0, v.currentTime + 10);
    else if (e.key === 'ArrowLeft') v.currentTime = Math.max(0, v.currentTime - 10);
    else if (e.key === 'j') v.currentTime = Math.max(0, v.currentTime - 30);
    else if (e.key === 'l') v.currentTime = Math.min(v.duration || 0, v.currentTime + 30);
    else if (e.key === 'f') toggleFs();
    else if (e.key === 'm') v.muted = !v.muted;
    else if (e.key === 'n' && P.data.nextId) location.hash = `#/w/${P.data.nextId}`;
    else if (e.key === 'Escape') $('#btn-back').click();
    else if (e.key === 'c') $('#btn-subs').click();
    showControls();
  }
});

$('#navback').addEventListener('click', () => (location.hash = '#/'));
$('#logo').addEventListener('click', () => (location.hash = '#/'));

// ---------- boot ----------
route();
