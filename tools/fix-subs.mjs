// Repairs subtitle database entries after the rename pass:
//  1. renames "X.en.srt.srt" double-extension artifacts back to ".srt"
//  2. re-points subtracks whose file vanished (rename fallout) to the right
//     subtitle file next to the (renamed) video

import fs from 'node:fs';
import path from 'node:path';
import cfg from '../src/config.js';
import { db, q } from '../src/db.js';
import { nameSimilarity, isSubFile } from '../src/clean.js';

let renamed = 0, repointed = 0, dropped = 0;

// 1. fix .srt.srt artifacts
const walk = (dir, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.srt.srt')) out.push(p);
  }
  return out;
};
for (const p of walk(cfg.mediaPath)) {
  const target = p.slice(0, -4); // strip one ".srt"
  if (!fs.existsSync(target)) { fs.renameSync(p, target); renamed++; }
  else if (fs.statSync(p).size > fs.statSync(target).size) { fs.renameSync(p, target); renamed++; }
  else fs.rmSync(p), renamed++;
}

// 2. repoint subtracks at files that no longer exist
const videos = q.allFiles.all().filter((f) => fs.existsSync(f.path));
for (const st of db.prepare('SELECT * FROM subtracks').all()) {
  if (fs.existsSync(st.path)) continue;

  // candidate fixes in order of confidence
  const f = q.fileById.get(st.file_id);
  let fixed = null;
  if (f && fs.existsSync(f.path)) {
    const dir = path.dirname(f.path);
    const base = path.basename(f.path, path.extname(f.path));
    let entries;
    try { entries = fs.readdirSync(dir); } catch {}
    const subs = (entries || []).filter((e) => isSubFile(e));
    // exact-ish: sub file sharing the video's base
    const sameBase = subs.filter((e) => path.basename(e, path.extname(e)).startsWith(base.slice(0, Math.max(4, base.length - 6))) || nameSimilarity(e, base) > 0.7);
    if (sameBase.length === 1) fixed = path.join(dir, sameBase[0]);
    else if (sameBase.length > 1) {
      // pick by language token match
      const want = (st.lang || 'en').slice(0, 2);
      fixed = path.join(dir, sameBase.find((e) => e.toLowerCase().includes(want)) || sameBase[0]);
    }
  }
  if (fixed && fs.existsSync(fixed)) {
    try {
      db.prepare('DELETE FROM subtracks WHERE file_id=? AND path=? AND id != ?').run(st.file_id, fixed, st.id);
      db.prepare('UPDATE subtracks SET path=?, format=? WHERE id=?').run(fixed, path.extname(fixed).slice(1).toLowerCase(), st.id);
      repointed++;
    } catch {
      db.prepare('DELETE FROM subtracks WHERE id=?').run(st.id); // duplicate row; the good one stays
      dropped++;
    }
  } else {
    db.prepare('DELETE FROM subtracks WHERE id=?').run(st.id);
    dropped++;
    if (f) db.prepare("UPDATE files SET subtitle_status='pending' WHERE id=?").run(st.file_id);
  }
}

console.log(`fix-subs: ${renamed} artifact(s) renamed, ${repointed} subtrack(s) repointed, ${dropped} dangling subtrack(s) removed`);
const broken = db.prepare('SELECT COUNT(*) n FROM subtracks').get().n;
console.log(`subtracks in db: ${broken}`);
