// One-shot (rerunnable) cleanup: keep only English subtitle tracks.
//
//  1. relabels rows whose lang tag is missing/unknown ('und', empty) but whose
//     generated file is named "<base>.en.srt" as English
//  2. deletes subtrack rows in any other language (judged by the lang tag, or
//     by the language token in the generated "<base>.<lang>.srt" filename)
//  3. deletes the generated non-English .srt files we extracted ourselves
//     (source === 'embedded'); external .srt files you placed are kept on disk,
//     just unlinked from the library
//  4. files left with zero tracks get subtitle_status='pending' so the normal
//     pipeline (English-only extraction, then Whisper) can refill them
//
// Usage: node tools/prune-subs.mjs [--dry-run] [--keep-files]

import fs from 'node:fs';
import path from 'node:path';
import { db, q } from '../src/db.js';

const dryRun = process.argv.includes('--dry-run');
const keepFiles = process.argv.includes('--keep-files');

const isEn = (lang) => !!lang && /^en/i.test(lang);
// language token in a generated filename: "<base>.fre.srt", "<base>.en-US.srt",
// "<base>.track2.srt" — external files without a token return null
const langToken = (p) => path.basename(p).match(/\.([A-Za-z]{2,3}(?:[-_][A-Za-z]{2,4})?|track\d+)\.srt$/);

let relabeled = 0, dropped = 0, filesDeleted = 0;
const touchedFiles = new Set();

for (const st of db.prepare('SELECT * FROM subtracks').all()) {
  const token = langToken(st.path);
  const fileLooksEn = !!token && /^(en|eng)/i.test(token[1]);

  if (isEn(st.lang)) continue; // already English

  if (fileLooksEn) {
    // generated ".en.srt" row carrying a bad/missing lang tag -> relabel
    touchedFiles.add(st.file_id);
    if (!dryRun) {
      db.prepare(`UPDATE subtracks SET lang='en',
        label = CASE WHEN label LIKE '%SDH%' THEN 'English (SDH)' ELSE 'English' END
        WHERE id=?`).run(st.id);
    }
    relabeled++;
    continue;
  }

  // non-English: drop the row, and the file too if we generated it
  touchedFiles.add(st.file_id);
  if (!dryRun) db.prepare('DELETE FROM subtracks WHERE id=?').run(st.id);
  if (st.source === 'embedded' && !keepFiles) {
    if (!dryRun) { try { fs.rmSync(st.path, { force: true }); } catch { /* ignore */ } }
    filesDeleted++;
  }
  dropped++;
}

// files that now have no tracks at all go back into the subtitle pipeline
let reset = 0;
for (const id of touchedFiles) {
  const f = q.fileById.get(id);
  if (!f || f.kind === 'extra') continue;
  if (!q.subtracksOfFile.all(id).length && f.subtitle_status !== 'pending') {
    if (!dryRun) db.prepare(`UPDATE files SET subtitle_status='pending' WHERE id=?`).run(id);
    reset++;
  }
}

console.log(`prune-subs${dryRun ? ' (dry run)' : ''}: ${relabeled} track(s) relabeled as English, ` +
  `${dropped} non-English track(s) removed, ${filesDeleted} generated .srt file(s) deleted, ` +
  `${reset} file(s) reset for the subtitle pass`);
if (dryRun) console.log('Run without --dry-run to apply.');
const total = db.prepare('SELECT COUNT(*) n FROM subtracks').get().n;
console.log(`subtracks in db${dryRun ? ' (unchanged)' : ' now'}: ${total}`);