import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import cfg from './src/config.js';
import { db, q } from './src/db.js';
import { scan } from './src/scanner.js';
import { queueWhisper, queueStatus } from './src/subtitles.js';
import { syncAll } from './src/tmdb.js';

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

app.get('/api/title/:id', (req, res) => {
  const t = q.getTitle.get(req.params.id);
  if (!t || t.hidden) return res.status(404).json({ error: 'not found' });
  const files = q.filesOfTitle.all(t.id);
  const fileIds = files.map((f) => f.id);
  const out = files.map((f, i) => {
    const p = q.getProgress.get(f.id);
    const tracks = q.subtracksOfFile.all(f.id);
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
      vcodec: f.vcodec, acodec: f.acodec,
      still: imgUrl(f.ep_still) || (f.thumb ? `/thumb/${f.id}` : null)
    },
    title: { id: t.id, name: t.name, year: t.year, backdrop: imgUrl(t.backdrop), poster: imgUrl(t.poster) },
    subtracks: q.subtracksOfFile.all(f.id).map((s) => ({ id: s.id, lang: s.lang, label: s.label, source: s.source })),
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

// ---------- Video streaming ----------

function transcodeStream(req, res, f, start = 0) {
  if (!start) {
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m && m[1]) start = +m[1];
  }
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', f.path, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '256k', '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4', 'pipe:1');
  res.writeHead(200, {
    'Content-Type': 'video/mp4', 'Accept-Ranges': 'none',
    'X-Transcoded': '1', 'Cache-Control': 'no-store'
  });
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
  const kill = () => { try { proc.kill('SIGKILL'); } catch {} };
  req.on('close', kill);
  res.on('close', kill);
}

// Audio-only transcode (video untouched) for codecs browsers can't decode
// (E-AC3, DTS, TrueHD, PCM). Streamed as MPEG-TS for MSE playback.
function mseAudioStream(req, res, f, start = 0) {
  const args = [];
  if (start > 0) args.push('-ss', String(start));
  args.push('-i', f.path, '-map', '0:v:0', '-map', '0:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '384k',
    '-mpegts_flags', 'resend_headers', '-f', 'mpegts', 'pipe:1');
  res.writeHead(200, {
    'Content-Type': 'video/mp2t', 'Accept-Ranges': 'none',
    'X-Playback-Mode': 'mse-audio', 'Cache-Control': 'no-store'
  });
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  proc.stdout.pipe(res);
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

// ---------- Start ----------

app.listen(cfg.port, () => {
  console.log(`Offline Netflix running:  http://localhost:${cfg.port}`);
  console.log(`Library: ${cfg.mediaPath}`);
});
