import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import cfg, { saveConfig } from './src/config.js';
import { db, q } from './src/db.js';
import { scan } from './src/scanner.js';
import { queueWhisper, queueStatus, harvestExternalSubs, extractEmbeddedSubs } from './src/subtitles.js';
import { syncAll, syncSeries, syncMovie } from './src/tmdb.js';
import { probeVideo } from './src/probe.js';

const app = express();
app.use(express.json());
app.use(express.static(path.join(cfg.root, 'public')));
app.use('/image', express.static(cfg.imagesDir, { maxAge: '30d' }));

const MIME = {
  '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.ts': 'video/mp2t',
  '.m4v': 'video/mp4', '.mpg': 'video/mpeg', '.mpeg': 'video/mpeg', '.wmv': 'video/x-msvideo'
};

const epTag = (s, e) => `S${String(s ?? 0).padStart(2, '0')}E${String(e ?? 0).padStart(2, '0')}`;
const imgUrl = (p) => (p ? '/image/' + path.basename(p) : null);

function titleCard(t) {
  const main = db.prepare(`SELECT * FROM files WHERE title_id = ? AND hidden = 0 AND kind != 'extra' ORDER BY kind, COALESCE(season,0), episode LIMIT 1`).get(t.id);
  return {
    id: t.id, kind: t.kind, name: t.name, year: t.year, overview: t.overview,
    poster: imgUrl(t.poster) || (main ? `/thumb/${main.id}` : null),
    backdrop: imgUrl(t.backdrop) || null,
    subBadge: main ? main.subtitle_status : null
  };
}

app.get('/api/health', (req, res) => res.json({ ok: true, media: cfg.mediaPath }));

// Playback diagnostics from the client: one line per playback event in
// server.log so stall causes are diagnosable after the fact.
app.post('/api/debug-stall', (req, res) => {
  console.log('[diag]', JSON.stringify(req.body || {}));
  res.json({ ok: true });
});

app.get('/api/library', (req, res) => {
  const cw = q.continueWatching.all().map((r) => ({
    fileId: r.file_id, titleId: r.title_id, kind: r.kind,
    name: r.t_name, label: r.kind === 'episode' ? `${epTag(r.season, r.episode)} · ${r.ep_name || ''}` : r.t_name,
    poster: imgUrl(r.t_poster) || (r.thumb ? `/thumb/${r.id}` : null),
    backdrop: imgUrl(r.t_backdrop) || (r.thumb ? `/thumb/${r.id}` : null),
    frac: r.frac || 0, position: r.position, duration: r.duration || 0
  }));
  res.json({
    continue: cw,
    series: q.titlesByKind.all('series').map(titleCard),
    movies: q.titlesByKind.all('movie').map(titleCard)
  });
});

// English-only subtitle display: rows in other languages (legacy data, or a
// subs pass that ran before the English-only filter) are hidden from the UI.
// Run `npm run subs:prune` to remove them from the DB for good.
const isEnSub = (s) => !!s.lang && /^en/i.test(s.lang);

app.get('/api/title/:id', (req, res) => {
  const t = q.getTitle.get(req.params.id);
  if (!t || t.hidden) return res.status(404).json({ error: 'not found' });
  const files = q.filesOfTitle.all(t.id);
  const fileIds = files.map((f) => f.id);
  const out = files.map((f, i) => {
    const p = q.getProgress.get(f.id);
    const tracks = q.subtracksOfFile.all(f.id).filter(isEnSub);
    return {
      id: f.id, kind: f.kind, season: f.season, episode: f.episode,
      epName: f.ep_name, epOverview: f.ep_overview,
      still: imgUrl(f.ep_still) || (f.thumb ? `/thumb/${f.id}` : null),
      thumb: f.thumb ? `/thumb/${f.id}` : null,
      duration: f.duration || p?.duration || 0,
      position: p?.position || 0,
      frac: p && p.duration ? Math.min(p.position / p.duration, 1) : 0,
      subCount: tracks.length,
      subStatus: f.subtitle_status,
      nextId: fileIds[i + 1] || null
    };
  });
  res.json({ title: { ...t, poster: imgUrl(t.poster), backdrop: imgUrl(t.backdrop) }, files: out });
});

app.get('/api/file/:id', (req, res) => {
  const f = q.fileById.get(req.params.id);
  if (!f) return res.status(404).json({ error: 'not found' });
  const t = q.getTitle.get(f.title_id);
  const siblings = q.filesOfTitle.all(t.id).filter((x) => x.kind !== 'extra');
  const idx = siblings.findIndex((x) => x.id === f.id);
  const p = q.getProgress.get(f.id);
  res.json({
    file: {
      id: f.id, kind: f.kind, season: f.season, episode: f.episode,
      epName: f.ep_name, epOverview: f.ep_overview, duration: f.duration || p?.duration || 0,
      vcodec: f.vcodec, acodec: f.acodec, vcodec_str: f.vcodec_str, acodec_str: f.acodec_str,
      width: f.width || null, height: f.height || null,
      still: imgUrl(f.ep_still) || (f.thumb ? `/thumb/${f.id}` : null)
    },
    title: { id: t.id, name: t.name, year: t.year, backdrop: imgUrl(t.backdrop), poster: imgUrl(t.poster) },
    subtracks: q.subtracksOfFile.all(f.id).filter(isEnSub).map((s) => ({ id: s.id, lang: s.lang, label: s.label, source: s.source })),
    nextId: f.kind === 'extra' ? null : (siblings[idx + 1]?.id ?? null),
    progress: p ? { position: p.position, duration: p.duration } : { position: 0, duration: 0 }
  });
});

app.post('/api/progress', (req, res) => {
  const { fileId, position, duration } = req.body || {};
  const f = q.fileById.get(fileId);
  if (!f) return res.status(404).json({ error: 'no such file' });
  q.setProgress.run({
    file_id: f.id, position: Math.max(0, +position || 0),
    duration: +duration || f.duration || 0, updated_at: Math.floor(Date.now() / 1000)
  });
  res.json({ ok: true });
});

// Remove from Continue Watching (deletes resume progress entirely).
app.delete('/api/progress/:fileId', (req, res) => {
  const f = q.fileById.get(+req.params.fileId);
  if (!f) return res.status(404).json({ error: 'no such file' });
  q.deleteProgress.run(f.id);
  res.json({ ok: true });
});

app.get('/api/search', (req, res) => {
  const term = `%${String(req.query.q || '').trim()}%`;
  if (!req.query.q || !req.query.q.trim()) return res.json({ results: [] });
  const titles = db.prepare(`SELECT * FROM titles WHERE hidden = 0 AND name LIKE ? ORDER BY name LIMIT 30`).all(term);
  res.json({ results: titles.map(titleCard) });
});

app.get('/api/queue', (req, res) => {
  const counts = db.prepare(`SELECT subtitle_status AS s, COUNT(*) AS n FROM files WHERE hidden=0 GROUP BY subtitle_status`).all();
  res.json({ whisper: queueStatus(), subs: counts });
});

app.post('/api/subtitles/generate', (req, res) => {
  const { fileId } = req.body || {};
  try {
    const r = queueWhisper(fileId);
    res.json({ ok: true, ...r, ...queueStatus() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/tmdb-sync', (req, res) => {
  syncAll().then((r) => res.json(r)).catch((e) => res.status(400).json({ error: e.message }));
});

app.post('/api/scan', async (req, res) => {
  try {
    const r = await scan({ probe: req.query.probe === '1', subs: req.query.subs !== '0' });
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- Settings ----------

const EDITABLE_KEYS = ['mediaPath', 'port', 'tmdbApiKey', 'autoScanMinutes', 'transcodeEnabled'];
const currentSettings = () => Object.fromEntries(EDITABLE_KEYS.map((k) => [k, cfg[k]]));

app.get('/api/settings', (req, res) => {
  res.json({ ...currentSettings(), mediaPathExists: fs.existsSync(cfg.mediaPath) });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const errors = {};
  const next = {};

  if ('mediaPath' in b) {
    const p = String(b.mediaPath || '').trim();
    try {
      if (!fs.statSync(p).isDirectory()) errors.mediaPath = 'not a folder';
      else next.mediaPath = p;
    } catch { errors.mediaPath = 'folder not found'; }
  }
  if ('autoScanMinutes' in b) {
    const n = Math.round(Number(b.autoScanMinutes));
    if (!Number.isFinite(n) || n < 0 || n > 1440) errors.autoScanMinutes = 'must be 0-1440';
    else next.autoScanMinutes = n;
  }
  if ('port' in b) {
    const n = Number(b.port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) errors.port = 'must be 1-65535';
    else next.port = n;
  }
  if ('tmdbApiKey' in b) next.tmdbApiKey = String(b.tmdbApiKey).trim();
  if ('transcodeEnabled' in b) next.transcodeEnabled = !!b.transcodeEnabled;

  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const prevMedia = cfg.mediaPath;
  const prevAuto = cfg.autoScanMinutes;
  saveConfig(next);
  if (('mediaPath' in next && next.mediaPath !== prevMedia) ||
      ('autoScanMinutes' in next && next.autoScanMinutes !== prevAuto)) startAutoScan();
  if (next.mediaPath && next.mediaPath !== prevMedia) autoScan('media path changed');
  res.json({ ok: true, settings: currentSettings() });
});

// ---------- Video streaming ----------

// Surface ffmpeg stderr in server.log so playback problems are diagnosable.
function pipeErrors(proc, label) {
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d.toString();
    if (buf.length > 8000) buf = buf.slice(-8000);
  });
  proc.on('close', (code) => {
    if (code !== 0 && code !== null) {
      console.error('[ffmpeg:' + label + '] exited ' + code + ':', buf.trim().split('\n').slice(-6).join(' | '));
    }
  });
}

// One-time GPU encoder probe. CPU x264 measured 0.44x realtime on 4K 10-bit
// HEVC (can't sustain playback) while NVENC handles ~1.3x — detect once at
// startup instead of assuming (many WSL setups CAN use NVENC now).
const probeNvenc = () => {
  try {
    execFileSync('ffmpeg',
      ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=0.3:size=640x360:rate=24',
        '-c:v', 'h264_nvenc', '-f', 'null', '-'],
      { timeout: 20000, stdio: 'ignore' });
    return true;
  } catch { return false; }
};

// Compatibility transcode. NVENC first (GPU — measured ~1.3x realtime on 4K
// 10-bit HEVC, vs 0.44x for CPU x264, which cannot sustain playback), with an
// automatic CPU fallback if the GPU encoder fails to start.
function transcodeStream(req, res, f, start = 0) {
  if (!start) {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && m[1]) start = +m[1];
  }
  const mkArgs = (cpu) => {
    const a = [];
    if (start > 0) a.push('-ss', String(start));
    a.push('-i', f.path);
    if (!cpu && cfg.nvencAvailable) {
      // h264_nvenc rejects 10-bit sources (yuv420p10le): format=nv12 converts.
      // The scale cap keeps sources wider than NVENC's 4096 limit in range.
      a.push('-vf', "format=nv12,scale='min(iw,3840)':-2",
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0');
    } else {
      a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    }
    a.push('-c:a', 'aac', '-b:a', '256k', '-movflags', 'frag_keyframe+empty_moov',
      '-flush_packets', '1', '-f', 'mp4', 'pipe:1');
    return a;
  };
  res.writeHead(200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'none',
    'X-Transcoded': '1', 'Cache-Control': 'no-store'
  });
  let proc = null, fellBack = false;
  const kill = () => { try { proc && proc.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
  const startProc = (cpu) => {
    proc = spawn('ffmpeg', mkArgs(cpu), { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.pipe(res);
    pipeErrors(proc, 'transcode ' + (cpu ? 'cpu' : 'nvenc') + ' ' + path.basename(f.path));
    proc.on('close', (code) => {
      // If the GPU encoder can't start (busy/unavailable/bad params), retry
      // once with the CPU encoder so compatibility mode still plays.
      if (!cpu && !fellBack && code !== 0 && code !== null) {
        fellBack = true;
        console.warn('[transcode] NVENC failed (exit ' + code + ') — retrying with CPU encoder');
        startProc(true);
      }
    });
  };
  startProc(!cfg.nvencAvailable);
}

// Video passthrough remux (fMP4 + MSE) for codecs browsers can't decode
// natively (E-AC3, DTS, ...). Audio copied when supported, else AAC.
function mseAudioStream(req, res, f, start = 0) {
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', f.path, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy',
    ...(req.query.acopy === '1' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '384k']),
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-flush_packets', '1', '-f', 'mp4', 'pipe:1');
  res.writeHead(200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'none',
    'X-Playback-Mode': 'mse-audio', 'Cache-Control': 'no-store'
  });
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.pipe(res);
  pipeErrors(proc, 'remux ' + path.basename(f.path) + (start ? ' @' + start + 's' : ''));
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
}

app.get('/stream/:fileId', (req, res) => {
  const f = q.fileById.get(+req.params.fileId);
  if (!f || !fs.existsSync(f.path)) return res.status(404).end();
  const start = Math.max(0, +req.query.start || 0);
  if (req.query.audio === '1' && cfg.transcodeEnabled) return mseAudioStream(req, res, f, start);
  if (req.query.transcode === '1' && cfg.transcodeEnabled) return transcodeStream(req, res, f, start);

  const size = fs.statSync(f.path).size;
  const type = MIME[path.extname(f.path).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? +m[1] : 0;
    const end = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size) {
      return res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type
    });
    fs.createReadStream(f.path, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Type': type });
    fs.createReadStream(f.path).pipe(res);
  }
});

app.get('/thumb/:fileId', (req, res) => {
  const f = q.fileById.get(+req.params.fileId);
  if (!f) return res.status(404).end();
  const p = f.thumb || f.ep_still;
  if (p && fs.existsSync(p)) return res.sendFile(p);
  res.status(404).end();
});

// ---------- Subtitle serving (always WebVTT to the browser) ----------

function srtToVtt(s) {
  return 'WEBVTT\n\n' + s.replace(
    /^(\d{1,2}:\d{2}:\d{2}),(\d{3}) --> (\d{1,2}:\d{2}:\d{2}),(\d{3})$/gm,
    '$1.$2 --> $3.$4'
  );
}

function assToVtt(srcPath) {
  const hash = crypto.createHash('md5').update(srcPath).digest('hex').slice(0, 16);
  const out = path.join(cfg.subsCacheDir, `${hash}.vtt`);
  if (!fs.existsSync(out)) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', srcPath, '-f', 'webvtt', out], { timeout: 60000 });
  }
  return out;
}

app.get('/subtitle/:trackId', (req, res) => {
  const st = q.subtrackById.get(+req.params.trackId);
  if (!st || !fs.existsSync(st.path)) return res.status(404).end();
  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  if (st.format === 'vtt') return fs.createReadStream(st.path).pipe(res);
  if (st.format === 'srt') return res.send(srtToVtt(fs.readFileSync(st.path, 'utf8')));
  if (st.format === 'ass' || st.format === 'ssa') {
    try { return res.send(srtToVtt(fs.readFileSync(assToVtt(st.path), 'utf8'))); }
    catch { return res.status(500).end(); }
  }
  res.status(415).end();
});

// ---------- Auto-scan (watch the media folder for new/removed files) ----------

let scanBusy = false;
let autoScanTimer = null;
let mediaWatcher = null;
let watchDebounce = null;

// Cheap diff-only pass: directory walk + path compare, no ffprobe/whisper.
async function autoScan(reason) {
  if (scanBusy) return;
  scanBusy = true;
  try {
    const r = await scan({ probe: false, subs: false });
    console.log(`[autoscan:${reason}] found=${r.videos} library=${r.files} removed=${r.removed} dupes=${r.dupes}`);
    if (r.added?.length) processNewMedia(r.added);
  } catch (e) {
    console.error(`[autoscan:${reason}]`, e.message);
  } finally {
    scanBusy = false;
  }
}

// ---------- New-media pipeline ----------
// When the auto-scan discovers files, finish the job automatically: probe
// durations, sync TMDB metadata for new titles, match/extract subtitles, and
// queue Whisper transcription when an NVIDIA GPU is present. Every step
// degrades gracefully on machines lacking it (no GPU, no venv, no TMDB key).

let pipelineBusy = false;
let gpuInfo = null;

function hasNvidiaGpu() {
  if (gpuInfo === null) {
    try { execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 10000 }); gpuInfo = true; }
    catch { gpuInfo = false; }
    if (gpuInfo) console.log('[new media] NVIDIA GPU detected — new files will be transcribed automatically');
  }
  return gpuInfo;
}

async function processNewMedia(addedIds) {
  if (pipelineBusy || !addedIds?.length) return;
  pipelineBusy = true;
  try {
    const rows = addedIds.map((id) => q.fileById.get(id)).filter((f) => f && fs.existsSync(f.path));
    if (!rows.length) return;
    const fresh = (f) => q.fileById.get(f.id);
    const isEpisode = (f) => !f.hidden && f.kind !== 'extra';
    const hasSubs = (f) => q.subtracksOfFile.all(f.id).length > 0;

    // 1. Probe the new files (durations/codec info) — small parallel pool.
    let idx = 0;
    async function probeWorker() {
      while (idx < rows.length) {
        const f = rows[idx++];
        try {
          const info = await probeVideo(f.path);
          q.updateFileProbe.run({ id: f.id, duration: info.duration, width: info.width, height: info.height, vcodec: info.vcodec, acodec: info.acodec, vcodec_str: info.vcodecStr, acodec_str: info.acodecStr });
        } catch { /* unreadable file; leave probe_done=0 */ }
      }
    }
    await Promise.all(Array.from({ length: 4 }, probeWorker));
    console.log(`[new media] probed ${rows.length} file(s)`);

    // 2. TMDB metadata for titles these files belong to (needs an API key).
    if (cfg.tmdbApiKey || process.env.TMDB_API_KEY) {
      const titleIds = [...new Set(rows.map((f) => f.title_id))];
      for (const id of titleIds) {
        const t = q.getTitle.get(id);
        if (!t || t.tmdb_synced || t.hidden) continue;
        try {
          const ok = t.kind === 'series' ? await syncSeries(t) : await syncMovie(t);
          console.log(`[new media] tmdb ${ok ? 'synced' : 'NO MATCH'}: ${t.name}`);
        } catch (e) {
          console.error('[new media] tmdb failed:', t.name, '-', e.message);
        }
      }
    }

    // 3. Subtitles: match external .srt files first (cheap), then extract
    //    embedded streams (ffmpeg reads the file once — slow on big 4K files).
    harvestExternalSubs();
    let extracted = 0;
    for (const f of rows) {
      const cur = fresh(f);
      if (!cur || !isEpisode(cur) || hasSubs(cur)) continue;
      try {
        const got = await extractEmbeddedSubs(cur);
        if (got.length) {
          db.prepare(`UPDATE files SET subtitle_status='done' WHERE id=?`).run(cur.id);
          extracted++;
        }
      } catch { /* no embedded subs / probe failed */ }
    }
    if (extracted) console.log(`[new media] embedded subs extracted for ${extracted} file(s)`);

    // 4. Whisper for whatever still has no subs — only with a real GPU, so a
    //    laptop never silently spends CPU-days transcribing.
    if (cfg.whisperAvailable && hasNvidiaGpu()) {
      let queued = 0;
      for (const f of rows) {
        const cur = fresh(f);
        if (!cur || !isEpisode(cur) || hasSubs(cur) || cur.subtitle_status === 'done') continue;
        try { queueWhisper(cur.id); queued++; } catch {}
      }
      if (queued) console.log(`[new media] queued ${queued} file(s) for Whisper transcription`);
    }
  } catch (e) {
    console.error('[new media] pipeline error:', e.message);
  } finally {
    pipelineBusy = false;
  }
}

function startAutoScan() {
  clearInterval(autoScanTimer);
  clearTimeout(watchDebounce);
  if (mediaWatcher) { try { mediaWatcher.close(); } catch {} mediaWatcher = null; }
  const mins = Math.max(0, Math.round(+cfg.autoScanMinutes || 0));
  if (!mins) return;
  autoScanTimer = setInterval(() => autoScan('timer'), mins * 60000);
  // Fast path: react to directory events. Some mounts (e.g. WSL /mnt/c drvfs)
  // never deliver inotify events, so the interval above is the safety net.
  try {
    if (fs.existsSync(cfg.mediaPath)) {
      mediaWatcher = fs.watch(cfg.mediaPath, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => autoScan('watch'), 15000);
      });
      mediaWatcher.on('error', () => { try { mediaWatcher.close(); } catch {} mediaWatcher = null; });
    }
  } catch (e) {
    console.warn('[autoscan] fs.watch unavailable, polling only:', e.message);
  }
}

// ---------- Start ----------

// Degrade gracefully on machines missing system tools (laptop, slim container)
// instead of failing later with cryptic per-request spawn errors.
const haveTool = (cmd) => {
  try { execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 10000 }); return true; }
  catch { return false; }
};
if (!haveTool('ffmpeg') || !haveTool('ffprobe')) {
  console.warn('[setup] ffmpeg/ffprobe not found on PATH — probing and compatibility transcoding are disabled. Install ffmpeg and restart.');
  cfg.transcodeEnabled = false;
}
if (!cfg.mediaPath || !fs.existsSync(cfg.mediaPath)) {
  console.warn('[setup] media folder not set or missing — open Settings (⚙) in the UI to pick it, or set MEDIA_PATH / config.json "mediaPath".');
}
if (!cfg.whisperAvailable) {
  console.warn('[setup] Whisper venv not found (tools/.venv) — AI subtitles are disabled. Run: bash tools/setup-whisper.sh');
}
if (!haveTool('ffmpeg') || !haveTool('ffprobe')) {
  console.warn('[setup] ffmpeg/ffprobe not found on PATH — probing and compatibility transcoding are disabled. Install ffmpeg and restart.');
  cfg.transcodeEnabled = false;
}
cfg.nvencAvailable = false;
if (cfg.transcodeEnabled) {
  cfg.nvencAvailable = probeNvenc();
  console.log(cfg.nvencAvailable
    ? '[setup] NVENC: available — compatibility mode transcodes on the GPU'
    : '[setup] NVENC: unavailable — compatibility mode falls back to CPU x264 (slow on 4K)');
}

app.listen(cfg.port, () => {
  console.log(`Offline Netflix running:  http://localhost:${cfg.port}`);
  console.log(`Library: ${cfg.mediaPath}`);
  if (cfg.whisperAvailable) console.log('Whisper: available (AI subtitles enabled)');
  startAutoScan();
  autoScan('startup');
});
