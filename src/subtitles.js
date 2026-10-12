import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { db, q } from './db.js';
import { isSubFile, nameSimilarity } from './clean.js';
import { probeVideo, ffmpeg } from './probe.js';

const LANGS = [
  ['english', 'en', 'English'], ['eng.', 'en', 'English'], ['sdh', 'en', 'English (SDH)'],
  ['ara', 'ar', 'Arabic'], ['brazilian', 'pt', 'Portuguese (Brazil)'], ['por.', 'pt', 'Portuguese'],
  ['canadian', 'fr', 'French (Canada)'], ['fre.', 'fr', 'French'], ['cze', 'cs', 'Czech'],
  ['dan', 'da', 'Danish'], ['dut', 'nl', 'Dutch'], ['ell', 'el', 'Greek'], ['fin', 'fi', 'Finnish'],
  ['ger', 'de', 'German'], ['hun', 'hu', 'Hungarian'], ['ita', 'it', 'Italian'],
  ['jpn', 'ja', 'Japanese'], ['kor', 'ko', 'Korean'], ['nor', 'nb', 'Norwegian'],
  ['pol', 'pl', 'Polish'], ['rus', 'ru', 'Russian'], ['spa', 'es', 'Spanish'],
  ['swe', 'sv', 'Swedish'], ['tur', 'tr', 'Turkish'], ['ukr', 'uk', 'Ukrainian'],
  ['vie', 'vi', 'Vietnamese'], ['chs', 'zh', 'Chinese'], ['chi.', 'zh', 'Chinese'],
  ['heb', 'he', 'Hebrew'], ['ron', 'ro', 'Romanian'], ['tha', 'th', 'Thai'], ['hin', 'hi', 'Hindi']
];

export function guessLang(filename) {
  const base = path.basename(filename, path.extname(filename)).toLowerCase();
  for (const [needle, code, label] of LANGS) {
    if (base.includes(needle)) return { code, label };
  }
  const extLang = path.extname(filename).slice(1).toLowerCase();
  if (extLang.length === 2) {
    const hit = LANGS.find(([, c]) => c === extLang);
    if (hit) return { code: hit[1], label: hit[2] };
  }
  return { code: null, label: null };
}

// Find all subtitle files under the media root.
export function findSubFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && isSubFile(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

// Match stray .srt/.ass files to the videos in the DB.
export function harvestExternalSubs() {
  const videos = q.allFiles.all().filter((f) => !f.hidden);
  const subFiles = findSubFiles(cfg.mediaPath);
  let matched = 0;
  for (const sub of subFiles) {
    const subDir = path.dirname(sub);
    const subBase = path.basename(sub, path.extname(sub));
    let best = null, bestScore = 0;
    for (const v of videos) {
      const vDir = path.dirname(v.path);
      const vBase = path.basename(v.path, path.extname(v.path));
      let score = nameSimilarity(subBase, vBase);
      const rel = path.relative(subDir, vDir);
      if (rel === '') score += 1.0;                             // same folder
      else if (rel.split(path.sep).length === 1) score += 0.4;  // adjacent (e.g. Subs/)
      if (score > bestScore) { bestScore = score; best = v; }
    }
    // Fallback: walk up from the sub's folder; the nearest ancestor that holds
    // exactly one video owns the sub (YTS "Subs/" layout, per-language srt names).
    if (!best || bestScore < 0.6) {
      let dir = subDir;
      for (let up = 0; up < 4 && dir.length > cfg.mediaPath.length; up++) {
        const vids = videos.filter((v) => path.dirname(v.path) === dir);
        if (vids.length === 1) { best = vids[0]; bestScore = 1; break; }
        if (vids.length > 1) break;
        dir = path.dirname(dir);
      }
    }
    if (best && bestScore >= 0.6) {
      const { code, label } = guessLang(sub);
      q.addSubtrack.run({
        file_id: best.id, path: sub,
        lang: code || 'en', label: label || 'External',
        source: 'external', format: path.extname(sub).slice(1).toLowerCase()
      });
      matched++;
    }
  }
  return { matched, total: subFiles.length };
}

// Extract subtitle streams embedded in an MKV/MP4 to .srt files next to the video.
export async function extractEmbeddedSubs(fileRow) {
  const probed = await probeVideo(fileRow.path);
  const dir = path.dirname(fileRow.path);
  const base = path.basename(fileRow.path, path.extname(fileRow.path));
  const extracted = [];
  let n = 0;
  for (const s of probed.subtitles.slice(0, 4)) {
    if (!['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(s.codec)) continue;
    const lang = s.lang && s.lang !== 'und' ? s.lang : (n === 0 ? 'en' : `track${n + 1}`);
    const out = path.join(dir, `${base}.${lang}.srt`);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) {
      try {
        fs.rmSync(out, { force: true });
        await ffmpeg(['-i', fileRow.path, '-map', `0:${s.index}`, '-c:s', 'srt', out], 3600000);
      } catch { fs.rmSync(out, { force: true }); continue; }
    }
    if (fs.existsSync(out) && fs.statSync(out).size > 0) {
      q.addSubtrack.run({
        file_id: fileRow.id, path: out, lang: s.lang || 'en',
        label: s.title || (s.lang || 'en').toUpperCase(),
        source: 'embedded', format: 'srt'
      });
      extracted.push(out);
      n++;
    }
  }
  return extracted;
}

// ---------- Whisper (GPU) transcription ----------

import * as childProcess from 'node:child_process';

const whisperQueue = [];
let whisperBusy = false;
const setFileStatus = db.prepare(`UPDATE files SET subtitle_status=? WHERE id=?`);

export function queueWhisper(fileId) {
  if (!q.fileById.get(fileId)) throw new Error('file not found');
  if (whisperQueue.includes(fileId)) return { queued: true, position: whisperQueue.indexOf(fileId) + 1 };
  whisperQueue.push(fileId);
  setFileStatus.run('waiting', fileId);
  setImmediate(pumpWhisper);
  return { queued: true, position: whisperQueue.length };
}

export function queueStatus() {
  return { busy: whisperBusy, pending: whisperQueue.length, next: whisperQueue[0] || null };
}

async function pumpWhisper() {
  if (whisperBusy) return;
  const fileId = whisperQueue.shift();
  if (fileId == null) return;
  whisperBusy = true;
  try {
    await transcribeFile(fileId);
  } catch (e) {
    console.error('[whisper] failed for file', fileId, e.message);
    setFileStatus.run('failed', fileId);
  }
  whisperBusy = false;
  setImmediate(pumpWhisper);
}

export async function transcribeFile(fileId) {
  const f = q.fileById.get(fileId);
  if (!f) throw new Error('file not found');
  const out = path.join(path.dirname(f.path), path.basename(f.path, path.extname(f.path)) + '.en.srt');
  if (fs.existsSync(out)) {
    q.addSubtrack.run({ file_id: fileId, path: out, lang: 'en', label: 'English (AI)', source: 'whisper', format: 'srt' });
    setFileStatus.run('done', fileId);
    return out;
  }
  setFileStatus.run('transcribing', fileId);
  await runWhisper(f.path, out);
  q.addSubtrack.run({ file_id: fileId, path: out, lang: 'en', label: 'English (AI)', source: 'whisper', format: 'srt' });
  setFileStatus.run('done', fileId);
  return out;
}

export function runWhisper(videoPath, outPath) {
  return new Promise((resolve, reject) => {
    const { execFile } = childProcess;
    execFile(cfg.venvPython, [
      path.join(cfg.root, 'tools', 'transcribe.py'),
      videoPath, outPath,
      '--model', cfg.whisperModel,
      '--language', cfg.whisperLanguage
    ], { timeout: 8 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { console.error('[whisper stderr]', (stderr || '').slice(-4000)); reject(err); }
      else resolve(stdout);
    });
  });
}
