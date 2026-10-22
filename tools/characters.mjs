// Canonical cast lists for speaker-named subtitles (see tools/transcribe.py
// --characters). Seeded from TMDB credits and cached in title_characters, so
// transcription itself stays offline.
//
// Usage:
//   node tools/characters.mjs                  # fill every title missing a cast
//   node tools/characters.mjs --all            # refresh all TMDB-sourced casts
//   node tools/characters.mjs --list           # print every title's list
//   node tools/characters.mjs --list Succession
//   node tools/characters.mjs --set Succession "Siobhan 'Shiv' Roy=Shiv"
//   node tools/characters.mjs --top 40         # wider cast when syncing
//
// --set stores source='manual' (survives --all refreshes). Setting the display
// to the canonical name ("X=X") keeps the full name in cues.

import { db, q } from '../src/db.js';
import { syncAllCharacters } from '../src/tmdb.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};
const topN = +(valueOf('--top') || 0) || 25;

function listCharacters(filter) {
  const titles = q.allTitles.all()
    .filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()));
  if (!titles.length) { console.log(`no title matching "${filter}"`); return; }
  for (const t of titles) {
    const rows = q.charactersForTitle.all(t.id);
    console.log(`\n${t.name} (${t.kind}, tmdb ${t.tmdb_id || '—'}) — ${rows.length} character(s)`);
    if (!rows.length) { console.log('  (none — no cast on TMDB, or not synced yet)'); continue; }
    for (const c of rows) {
      const aliases = JSON.parse(c.aliases || '[]');
      console.log(`  ${String(c.display).padEnd(18)} ${c.name.padEnd(28)} ${String(c.episodes).padStart(3)}ep` +
        `${aliases.length ? '  aka ' + aliases.join(', ') : ''}${c.source === 'manual' ? '  [manual]' : ''}`);
    }
  }
}

function setCharacter(titleName, assignment) {
  const [name, display] = String(assignment || '').split('=').map((s) => s && s.trim());
  if (!name || !display) {
    console.error('usage: --set "<title>" "<canonical name>=<display>"');
    process.exit(1);
  }
  const t = q.allTitles.all().find((x) => x.name.toLowerCase() === titleName.toLowerCase());
  if (!t) { console.error(`no title named "${titleName}"`); process.exit(1); }
  const row = q.charactersForTitle.all(t.id).find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!row) {
    console.error(`"${name}" is not in ${t.name}'s cast — see --list "${t.name}"`);
    process.exit(1);
  }
  q.upsertCharacter.run({
    title_id: t.id, name: row.name, display, aliases: row.aliases,
    episodes: row.episodes, source: 'manual'
  });
  console.log(`${t.name}: ${row.name} -> "${display}" (manual)`);
}

if (flag('--list')) {
  listCharacters(valueOf('--list'));
} else if (flag('--set')) {
  setCharacter(valueOf('--set'), argv[argv.indexOf('--set') + 2]);
} else {
  try {
    const r = await syncAllCharacters({ refresh: flag('--all'), topN });
    console.log(`\nCast sync: ${r.ok} title(s) with cast (${r.chars} characters stored), ` +
      `${r.empty} without cast, ${r.fail} failed, of ${r.total} matched titles.`);
    if (r.empty) console.log('Titles without cast keep generic SPEAKER n: cues (documentaries, mostly).');
  } catch (e) {
    console.error('\n' + e.message);
    process.exit(1);
  }
}
