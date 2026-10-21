// One-shot (rerunnable) reset of the library's subtitles:
//   1. deletes the selected subtrack rows and their generated .srt files
//      (embedded and whisper sources; anything external should already be
//      *.external-bak)
//   2. sets subtitle_status='pending' so the next `npm run subs` pass
//      regenerates them with the current pipeline — diarized,
//      speaker-named Whisper subtitles (see tools/transcribe.py --diarize)
//
// Run while the app is idle: a file queued or mid-transcription when this runs
// may still complete and re-add its track.
//
// Usage: node tools/subs-regen.mjs [--dry-run] [--label <label>] [--unnamed]
//   --label <label>  only reset tracks carrying exactly this label, e.g.
//                    --label "English (AI)" redoes just the tracks whose
//                    speaker naming fell back to generic SPEAKER n: cues.
//                    Files that keep other tracks stay 'done'.
//   --unnamed        shorthand for --label "English (AI)"

import fs from 'node:fs';
import { db, q } from '../src/db.js';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const labelVal = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : null;
const labelArg = argv.includes('--unnamed')
  ? 'English (AI)'
  : (labelVal && !labelVal.startsWith('--') ? labelVal : null);
if (argv.includes('--label') && !labelArg) {
  console.error('subs-regen: --label needs a value, e.g. --label "English (AI)"');
  process.exit(1);
}
const match = (st) => !labelArg || (st.label || '') === labelArg;

const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra');
let rows = 0, filesDeleted = 0, reset = 0, empty = 0, kept = 0;

for (const f of files) {
  const tracks = q.subtracksOfFile.all(f.id);
  if (!tracks.length) { empty++; continue; }
  const targets = tracks.filter(match);
  if (!targets.length) { kept++; continue; }
  for (const st of targets) {
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
    const del = db.prepare('DELETE FROM subtracks WHERE id=?');
    for (const st of targets) del.run(st.id);
    // Only back to pending once nothing is left to play for this file.
    if (targets.length === tracks.length) {
      db.prepare(`UPDATE files SET subtitle_status='pending' WHERE id=?`).run(f.id);
    }
  }
  if (targets.length === tracks.length) reset++;
  else kept++;
}

const will = dry ? 'would be ' : '';
const scope = labelArg ? `label "${labelArg}"` : 'whole library';
console.log(`subs-regen${dry ? ' (dry run)' : ''} [${scope}]: ${rows} track row(s) ${will}removed, ` +
  `${filesDeleted} generated .srt file(s) ${will}deleted, ` +
  `${reset} file(s) reset to pending, ${empty} already had no tracks` +
  (labelArg ? `, ${kept} file(s) left untouched` : ''));
if (dry) console.log('Run without --dry-run to apply, then: npm run subs');
else console.log('Next: npm run subs -- --whisper-only  (pending files only; this takes a long time)');