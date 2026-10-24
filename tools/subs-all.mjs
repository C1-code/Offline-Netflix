// One-shot subtitle pass over the whole library, in priority order:
//   1. subtitle streams embedded in MKV/MP4 (extracted with ffmpeg)
//   2. Whisper (GPU) transcription for anything that still has none
// External .srt/.ass files are never used (AI-only subtitles).
// Resumable: files that already have tracks are skipped.
//
// --whisper-only  skip embedded extraction entirely — every file lacking a
//                 track is sent straight to Whisper. Used together with
//                 tools/subs-regen.mjs to force the whole library through the
//                 diarized, speaker-named transcription pipeline.
//
// --title <name>  only process files of that title (repeatable, or one
//                 comma-separated list). Lets you do Community first, then run
//                 again with no filter for the rest — done files are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, q } from '../src/db.js';
import { extractEmbeddedSubs, transcribeFile } from '../src/subtitles.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const errorLog = path.join(dataDir, 'subs-errors.log');

const whisperOnly = process.argv.includes('--whisper-only');
const setStatus = db.prepare(`UPDATE files SET subtitle_status=? WHERE id=?`);

const dryRun = process.argv.includes('--dry-run');
const only = process.argv
  .flatMap((a, i, arr) => (a === '--title' ? [arr[i + 1]] : []))
  .filter(Boolean)
  .flatMap((v) => v.split(','))
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const matchesOnly = (f) => !only.length ||
  only.some((want) => (titleName.get(f.title_id) || '').toLowerCase().includes(want));

const todo = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra' && matchesOnly(f));
if (only.length) {
  console.log(`Title filter: ${[...new Set(only)].join(', ')} — ${todo.length} file(s) in scope`);
  if (!todo.length) {
    console.log('No files matched. Check the title name with: npm run chars:list');
    process.exit(0);
  }
}
if (dryRun) {
  const need = todo.filter((f) => !q.subtracksOfFile.all(f.id).length);
  const mins = need.reduce((n, f) => n + (f.duration || 0), 0) / 60;
  console.log(`Dry run: ${need.length} of ${todo.length} file(s) would be transcribed ` +
    `(${Math.round(mins)} min of media).`);
  process.exit(0);
}
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
  // 1: embedded (skipped in --whisper-only mode: force everything through
  // Whisper so the whole library gets speaker-named subtitles)
  if (!whisperOnly) {
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
  }

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
    const detail = (e && (e.stack || e.message)) || String(e);
    setStatus.run('failed', f.id);
    failed++;
    done++;
    process.stdout.write(`\r[${done + skipped}/${todo.length}] FAILED: ${label.slice(0, 60)}${' '.repeat(10)}\n`);
    console.error('   ', detail.replace(/\s+/g, ' ').slice(0, 400));
    // Console output is lost as soon as the shell that started the pass is
    // gone (or /tmp is cleared). Keep a durable, greppable record so a bulk
    // failure can be diagnosed afterwards.
    try {
      fs.appendFileSync(errorLog,
        `${new Date().toISOString()}\t${f.path}\t${detail.replace(/\s+/g, ' ').slice(0, 1500)}\n`);
    } catch { /* logging must never break the pass */ }
  }
}

console.log(`\n\nSubtitle pass complete: ${extracted} from embedded streams, ${transcribed} via Whisper, ` +
  `${skipped} already had subs, ${failed} failed.`);
if (failed) console.log(`Failure details appended to ${errorLog}`);
console.log('Re-run this command any time — it only processes files that still lack subtitles.');
