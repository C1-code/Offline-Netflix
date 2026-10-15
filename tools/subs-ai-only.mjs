// One-off migration to AI-only subtitles:
//   1. drop every subtrack row whose source is 'external', plus dangling rows
//      whose video no longer exists in the files table
//   2. rename the files those rows referenced to "*.external-bak" so they can
//      never be re-matched or re-labeled (kept on disk, not deleted)
//   3. also rename stray "<video-base>.<lang>.srt" companions next to DB
//      videos even when untracked — they would collide with embedded-stream
//      extraction (which skips existing files) and with Whisper output
//   4. reset subtitle_status for files left without any track
// Usage: node tools/subs-ai-only.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import cfg from '../src/config.js';
import { db, q } from '../src/db.js';

const dry = process.argv.includes('--dry-run');
const SUB_EXT = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub']);

const allTracks = db.prepare('SELECT * FROM subtracks').all();
const fileById = new Map(q.allFiles.all().map((f) => [f.id, f]));
const videos = [...fileById.values()].filter((f) => !f.hidden && f.kind !== 'extra');
const videoBase = new Map(videos.map((f) => [path.basename(f.path, path.extname(f.path)).toLowerCase(), f]));

let dropped = 0, renamed = 0, reset = 0, kept = 0;

// 1+2: drop external / dangling rows and move their files out of the way
const doomed = allTracks.filter((st) => !fileById.get(st.file_id) || st.source === 'external');
for (const st of allTracks) if (!doomed.includes(st)) kept++;

for (const st of doomed) {
  if (!dry) db.prepare('DELETE FROM subtracks WHERE id=?').run(st.id);
  dropped++;
  const p = st.path;
  if (!fs.existsSync(p)) continue;
  if (!dry) { try { fs.renameSync(p, p + '.external-bak'); } catch (e) { console.error('  rename failed:', p, e.message); continue; } }
  renamed++;
}

// 3: stray companion subtitle files sitting next to DB videos (not referenced
// by any surviving row). Only files named after the video itself are touched,
// because those are the ones that shadow embedded/whisper output paths.
const keepPaths = new Set(db.prepare('SELECT path FROM subtracks').all().map((r) => r.path));
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile() && SUB_EXT.has(path.extname(e.name).toLowerCase()) && !keepPaths.has(p) && fs.existsSync(p)) {
      const m = e.name.toLowerCase().match(/^(.+?)(?:\.[a-z]{2,3}(?:[-_][a-z]{2,4})?)?\.(?:srt|ass|ssa|vtt|sub)$/);
      if (m && videoBase.has(m[1]) && videoBase.get(m[1]).path.split(path.sep).slice(0, -1).join(path.sep) === dir) {
        if (!dry) { try { fs.renameSync(p, p + '.external-bak'); } catch (e2) { console.error('  rename failed:', p, e2.message); return; } }
        renamed++;
      }
    }
  }
};
if (cfg.mediaPath) walk(cfg.mediaPath);

// 4: reset files that now have no tracks (leave any in-flight whisper work alone)
for (const f of q.allFiles.all()) {
  if (f.hidden || f.kind === 'extra') continue;
  const n = db.prepare('SELECT COUNT(*) AS n FROM subtracks WHERE file_id=?').get(f.id).n;
  if (n === 0 && !['pending', 'waiting', 'transcribing'].includes(f.subtitle_status)) {
    if (!dry) db.prepare(`UPDATE files SET subtitle_status='pending' WHERE id=?`).run(f.id);
    reset++;
  } else if (n > 0 && f.subtitle_status !== 'done' && !['waiting', 'transcribing'].includes(f.subtitle_status)) {
    if (!dry) db.prepare(`UPDATE files SET subtitle_status='done' WHERE id=?`).run(f.id);
    reset++;
  }
}

console.log(`subs-ai-only${dry ? ' (dry run)' : ''}: ${dropped} external/dangling track(s) dropped, ` +
  `${renamed} subtitle file(s) renamed to *.external-bak, ${kept} track(s) kept, ${reset} file status(es) updated`);
if (dry) console.log('Run without --dry-run to apply.');
console.log('Next: node tools/subs-all.mjs (or npm run subs) to transcribe everything with Whisper.');
