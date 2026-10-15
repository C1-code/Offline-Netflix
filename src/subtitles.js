import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { db, q } from './db.js';
import { probeVideo, ffmpeg } from './probe.js';



// Extract subtitle streams embedded in an MKV/MP4 to .srt files next to the video.
export async function extractEmbeddedSubs(fileRow) {
  const probed = await probeVideo(fileRow.path);
  const dir = path.dirname(fileRow.path);
  const base = path.basename(fileRow.path, path.extname(fileRow.path));
  const extracted = [];
  let n = 0;
  for (const s of probed.subtitles.slice(0, 4)) {
    if (!['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text'].includes(s.codec)) continue;
    // English only: foreign-language streams are skipped (a release MKV can
    // carry a dozen languages). Anything left with no English track falls
    // through to Whisper, which always produces English.
    if (!s.lang || !/^en/i.test(s.lang)) continue;
    // "Forced" streams only translate the foreign-language dialogue (they are
    // a supplement, never full coverage). Skip them: a file whose only English
    // stream is forced should get a full Whisper transcript instead.
    if (/forced/i.test(s.title || '')) continue;
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
  // Always transcribe fresh: a <video>.en.srt that already exists on disk is a
  // stale external download (the AI-only pipeline never trusts those), so
  // Whisper overwrites it instead of silently re-attaching it as "AI" output.
  fs.rmSync(out, { force: true });
  setFileStatus.run('transcribing', fileId);
  await runWhisper(f.path, out);
  q.addSubtrack.run({ file_id: fileId, path: out, lang: 'en', label: 'English (AI)', source: 'whisper', format: 'srt' });
  setFileStatus.run('done', fileId);
  return out;
}

// pip-installed CUDA libs (nvidia-cublas-cu12, nvidia-cudnn-cu12) live inside
// the venv and are NOT on the system loader path — without this, ctranslate2
// raises "libcublas.so.12 is not found" and transcribe.py silently falls back
// to CPU (hours per episode). Point LD_LIBRARY_PATH at the venv's copies.
function whisperEnv() {
  const env = { ...process.env };
  try {
    const dirs = [];
    const libRoot = path.join(cfg.root, 'tools', '.venv', 'lib');
    for (const v of fs.readdirSync(libRoot)) {
      for (const pkg of ['cublas', 'cudnn']) {
        const d = path.join(libRoot, v, 'site-packages', 'nvidia', pkg, 'lib');
        if (fs.existsSync(d)) dirs.push(d);
      }
    }
    if (dirs.length) {
      env.LD_LIBRARY_PATH = dirs.join(':') + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
    }
  } catch { /* no venv libs — let transcribe.py fall back on its own */ }
  return env;
}

export function runWhisper(videoPath, outPath) {
  return new Promise((resolve, reject) => {
    // Machine without a Whisper venv (laptop, slim container): fail this one
    // file with a clear message instead of a spawn ENOENT deep in execFile.
    if (!cfg.whisperAvailable) {
      reject(new Error('Whisper not installed (tools/.venv missing) — run tools/setup-whisper.sh for AI subtitles'));
      return;
    }
    const { execFile } = childProcess;
    execFile(cfg.venvPython, [
      path.join(cfg.root, 'tools', 'transcribe.py'),
      videoPath, outPath,
      '--model', cfg.whisperModel,
      '--language', cfg.whisperLanguage,
      '--task', 'translate'  // always produce English, even for foreign audio
    ], { timeout: 8 * 60 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: whisperEnv() }, (err, stdout, stderr) => {
      if (err) { console.error('[whisper stderr]', (stderr || '').slice(-4000)); reject(err); }
      else resolve(stdout);
    });
  });
}
