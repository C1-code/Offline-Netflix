// One-shot subtitle pass over the whole library, in priority order:
//   1. subtitle streams embedded in MKV/MP4 (extracted with ffmpeg)
//   2. Whisper (GPU) transcription for anything that still has none
// External .srt/.ass files are never used (AI-only subtitles).
// Resumable: files that already have tracks are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { db, q } from '../src/db.js';
import { extractEmbeddedSubs, transcribeFile } from '../src/subtitles.js';

const setStatus = db.prepare(`UPDATE files SET subtitle_status=? WHERE id=?`);

const todo = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
let done = 0, extracted = 0, transcribed = 0, failed = 0, skipped = 0;

for (const f of todo) {
  const label = `${path.basename(f.path)}`;
  const tracks = q.subtracksOfFile.all(f.id);
  if (tracks.length) {
    setStatus.run('done', f.id);
    skipped++;
    process.stdout.write(`\r[${done + skipped}/${todo.length}] skip (has subs): ${label.slice(0, 60)}${' '.repeat(10)}`);
    continue;
  }
  // 1: embedded
  try {
    const got = await extractEmbeddedSubs(f);
    if (got.length) {
      setStatus.run('done', f.id);
      extracted++;
      done++;
      process.stdout.write(`\r[${done + skipped}/${todo.length}] embedded -> ${got.length} track(s): ${label.slice(0, 60)}${' '.repeat(10)}`);
      continue;
    }
  } catch { /* fall through to whisper */ }

  // 2: whisper
  try {
    setStatus.run('transcribing', f.id);
    const t0 = Date.now();
    await transcribeFile(f.id);
    transcribed++;
    done++;
    const mins = ((f.duration || 0) / 60).toFixed(0);
    process.stdout.write(`\r[${done + skipped}/${todo.length}] whisper (${mins}min in ${(Date.now() - t0) / 1000 | 0}s): ${label.slice(0, 60)}${' '.repeat(10)}`);
  } catch (e) {
    setStatus.run('failed', f.id);
    failed++;
    done++;
    process.stdout.write(`\r[${done + skipped}/${todo.length}] FAILED: ${label.slice(0, 60)}${' '.repeat(10)}\n`);
    console.error('   ', e.message?.slice(0, 200));
  }
}

console.log(`\n\nSubtitle pass complete: ${extracted} from embedded streams, ${transcribed} via Whisper, ` +
  `${skipped} already had subs, ${failed} failed.`);
console.log('Re-run this command any time — it only processes files that still lack subtitles.');
