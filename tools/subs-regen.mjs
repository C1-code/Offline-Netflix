// One-shot (rerunnable) reset of the whole library's subtitles:
//   1. deletes every subtrack row and its generated .srt file (embedded and
//      whisper sources; anything external should already be *.external-bak)
//   2. sets subtitle_status='pending' so the next `npm run subs` pass
//      regenerates everything with the current pipeline — diarized,
//      speaker-named Whisper subtitles (see tools/transcribe.py --diarize)
//
// Run while the app is idle: a file queued or mid-transcription when this runs
// may still complete and re-add its track.
//
// Usage: node tools/subs-regen.mjs [--dry-run]

import fs from 'node:fs';
import { db, q } from '../src/db.js';

const dry = process.argv.includes('--dry-run');

const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
let rows = 0, filesDeleted = 0, reset = 0, empty = 0;

for (const f of files) {
  const tracks = q.subtracksOfFile.all(f.id);
  if (!tracks.length) { empty++; continue; }
  for (const st of tracks) {
    rows++;
    if (st.source === 'external') continue; // row only — never delete a user's file
    try {
      if (fs.existsSync(st.path)) {
        if (!dry) fs.rmSync(st.path, { force: true });
        filesDeleted++;
      }
    } catch { /* keep going */ }
  }
  if (!dry) {
    db.prepare('DELETE FROM subtracks WHERE file_id=?').run(f.id);
    db.prepare(`UPDATE files SET subtitle_status='pending' WHERE id=?`).run(f.id);
  }
  reset++;
}

const will = dry ? 'would be ' : '';
console.log(`subs-regen${dry ? ' (dry run)' : ''}: ${rows} track row(s) ${will}removed, ` +
  `${filesDeleted} generated .srt file(s) ${will}deleted, ` +
  `${reset} file(s) reset to pending, ${empty} already had no tracks`);
if (dry) console.log('Run without --dry-run to apply, then: npm run subs');
else console.log('Next: npm run subs -- --whisper-only  (every file is re-transcribed; this takes a long time)');