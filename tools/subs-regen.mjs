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
//                                  [--title <name>[,<name>...]]
//   --label <label>  only reset tracks carrying exactly this label, e.g.
//                    --label "English (AI)" redoes just the tracks that ended
//                    up without any speaker naming at all.
//   --unnamed        redo tracks whose cues still contain generic SPEAKER n:
//                    fallbacks. Tracks with at least one named speaker are
//                    labeled "English (AI, named)" even when other speakers
//                    stayed anonymous, so this matches on the generated file's
//                    content instead of an exact label.

import fs from 'node:fs';
import { db, q } from '../src/db.js';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry-run');
const unnamedArg = argv.includes('--unnamed');
const only = argv
  .flatMap((a, i, arr) => (a === '--title' ? [arr[i + 1]] : []))
  .filter(Boolean)
  .flatMap((v) => v.split(','))
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);
const titleName = new Map(q.allTitles.all().map((t) => [t.id, t.name]));
const inScope = (f) => !only.length ||
  only.some((want) => (titleName.get(f.title_id) || '').toLowerCase().includes(want));
const labelVal = argv.includes('--label') ? argv[argv.indexOf('--label') + 1] : null;
const labelArg = unnamedArg
  ? null
  : (labelVal && !labelVal.startsWith('--') ? labelVal : null);
if (argv.includes('--label') && !labelArg) {
  console.error('subs-regen: --label needs a value, e.g. --label "English (AI)"');
  process.exit(1);
}

// A named track can still contain "SPEAKER 8:" for the speakers the model
// could not identify, so --unnamed inspects the generated .srt itself.
const hasSpeakerFallback = (p) => {
  try {
    return /(^|\n)\s*SPEAKER\s+\d+:/i.test(fs.readFileSync(p, 'utf8'));
  } catch {
    return false;
  }
};

const match = (st) => {
  if (unnamedArg) {
    return st.source !== 'external' &&
      /^English \(AI\b/.test(st.label || '') &&
      hasSpeakerFallback(st.path);
  }
  return !labelArg || (st.label || '') === labelArg;
};

const files = q.allFiles.all().filter((f) => !f.hidden && f.kind !== 'extra' && inScope(f));
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
const labelScope = labelArg
  ? `label "${labelArg}"`
  : (unnamedArg ? 'tracks with SPEAKER n: fallbacks' : 'whole library');
const scope = only.length ? `${labelScope}, titles ${[...new Set(only)].join('/')}` : labelScope;
console.log(`subs-regen${dry ? ' (dry run)' : ''} [${scope}]: ${rows} track row(s) ${will}removed, ` +
  `${filesDeleted} generated .srt file(s) ${will}deleted, ` +
  `${reset} file(s) reset to pending, ${empty} already had no tracks` +
  ((labelArg || unnamedArg) ? `, ${kept} file(s) left untouched` : ''));
if (dry) console.log('Run without --dry-run to apply, then: npm run subs');
else console.log('Next: npm run subs -- --whisper-only  (pending files only; this takes a long time)');
