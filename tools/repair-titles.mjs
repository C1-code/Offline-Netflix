// One-off title repair: re-links files stranded on duplicate, unsynced title
// rows (created by exact-name matching when folder names differ from TMDB
// names, e.g. "Avengers Endgame" vs "Avengers: Endgame") onto the synced
// titles that carry the posters/metadata, then removes the empty husks.
// Run once:  node tools/repair-titles.mjs
import { db } from '../src/db.js';

const byName = (n) => db.prepare('SELECT * FROM titles WHERE name = ? COLLATE NOCASE').get(n);

// [stranded duplicate title, synced title that should own the files]
const moves = [
  ['F1 the Movie', 'F1'],
  ['Jurassic World Fallen Kingdom', 'Jurassic World: Fallen Kingdom'],
  ['Avengers Endgame', 'Avengers: Endgame'],
  ['Avengers Infinity War', 'Avengers: Infinity War'],
  ['Black Panther Wakanda Forever', 'Black Panther: Wakanda Forever'],
  ['Captain America Brave New World', 'Captain America: Brave New World'],
  ['Deadpool Wolverine', 'Deadpool & Wolverine'],
  ['Shang - Chi and the Legend of the Ten Rings', 'Shang-Chi and the Legend of the Ten Rings'],
  ['SpiderMan No Way Home', 'Spider-Man: No Way Home'],
  ['Thunderbolts', 'Thunderbolts*'],
  ['X - Men', 'X-Men'],
  ['The Fantastic Four First Steps', 'The Fantastic 4: First Steps'],
  ['Captain America the First Avenger', 'Captain America: The First Avenger']
];

let moved = 0, removed = 0;

db.transaction(() => {
  for (const [from, to] of moves) {
    const src = byName(from), dst = byName(to);
    if (!src || !dst) {
      console.log(`skip: ${from} -> ${to} (${!src ? 'source missing' : 'target missing'})`);
      continue;
    }
    const n = db.prepare('SELECT COUNT(*) c FROM files WHERE title_id=?').get(src.id).c;
    if (n) {
      db.prepare('UPDATE files SET title_id=? WHERE title_id=?').run(dst.id, src.id);
      moved += n;
      console.log(`moved ${n} file(s): ${from} -> ${to}`);
    }
    if (!db.prepare('SELECT COUNT(*) c FROM files WHERE title_id=?').get(src.id).c) {
      db.prepare('DELETE FROM titles WHERE id=?').run(src.id);
      removed++;
    }
  }

  // Community was split into two bogus titles by folder-name parsing; merge
  // and rename so TMDB can match it.
  const a = byName('Community 2009 -');
  const b = byName('Community 2009 - 2015');
  if (a && b) {
    db.prepare('UPDATE files SET title_id=? WHERE title_id=?').run(a.id, b.id);
    db.prepare('DELETE FROM titles WHERE id=?').run(b.id);
    db.prepare('UPDATE titles SET name=?, sort_name=?, folder=? WHERE id=?')
      .run('Community', 'community', 'Community (2009 - 2015)', a.id);
    console.log('merged Community split titles into "Community"');
  } else {
    console.log('Community split titles not found (already merged?)');
  }
})();

console.log(`done: ${moved} file(s) re-linked, ${removed} husk title(s) removed`);
console.log('next: npm run tmdb:sync, then npm run scan');