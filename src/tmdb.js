import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { db, q } from './db.js';
import { nameSimilarity } from './clean.js';

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

function key() {
  const k = cfg.tmdbApiKey || process.env.TMDB_API_KEY;
  if (!k) {
    throw new Error(
      'No TMDB API key. Get a free one at https://www.themoviedb.org/settings/api ' +
      'and put it in config.json as "tmdbApiKey" (or set TMDB_API_KEY).'
    );
  }
  return k;
}

async function get(pathname, params = {}) {
  const url = new URL(API + pathname);
  url.searchParams.set('api_key', key());
  url.searchParams.set('language', cfg.tmdbLanguage || 'en');
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  // TMDB throttles bursts (429). Retry with backoff instead of letting one
  // throttled season fetch silently skip that season's metadata forever.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = res.headers.get('retry-after');
      const wait = retryAfter ? +retryAfter * 1000 : Math.min(30000, 2000 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`TMDB ${res.status} for ${pathname}`);
  }
}

async function download(url, dest) {
  if (fs.existsSync(dest)) return dest;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

const imgName = (tmdbId, kind, size, file) =>
  path.join(cfg.imagesDir, `tmdb-${tmdbId}-${kind}-${size}-${file}`);

// --- canonical cast (speaker naming) ---------------------------------------

// Ranks/titles that must not become the cue label: "Major Partagaz" is
// addressed as Partagaz, not Major.
const HONORIFICS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'mister', 'madam', 'madame', 'sir',
  'dr', 'doctor', 'prof', 'professor', 'capt', 'captain', 'lt', 'lieutenant',
  'sgt', 'sergeant', 'det', 'detective', 'officer', 'major', 'general',
  'col', 'colonel', 'admiral', 'senator', 'supervisor', 'chef', 'dean',
  'father', 'sister', 'brother', 'agent', 'director', 'president', 'king',
  'queen', 'prince', 'princess', 'lord', 'lady', 'judge', 'nurse', 'coach',
  'chief', 'commander', 'deputy', 'mayor', 'inspector', 'sheriff',
  'constable', 'priest', 'reverend', 'chancellor', 'minister', 'chairman'
]);

// Cast entries that are not characters at all: documentaries list their
// subjects as "Self", crowd roles are numbered, etc. Dropping these keeps the
// naming prompt free of noise (and makes F1-style shows fall back cleanly).
const NOT_A_CHARACTER = [
  /^(self|himself|herself|themself|narrator|host|hostess|interviewer|announcer|voice|additional voices?|various)$/i,
  // Unnamed background roles: giving these a display name ("Coffee") only
  // pollutes the naming prompt and steals a slot from a real character.
  /^(student|girl|boy|man|woman|guy|nurse|waiter|waitress|bartender|guard|cop|driver|clerk|cashier|patron|customer|audience|crowd|teacher|professor|delivery guy|coffee delivery guy|pizza guy|security guard)$/i,
  /^board member\b/i,
  /\bhuman being\b/i,
  /#\d+$/,
  /^number \d+$/i
];

/** Display name for a character, given the title kind. */
function displayFor(plain, quoted, kind) {
  if (quoted) return quoted;
  const toks = plain.split(' ').filter(Boolean);
  if (!toks.length) return plain;
  const first = toks[0].toLowerCase().replace(/\.$/, '');
  if (toks.length > 1 && HONORIFICS.has(first)) return toks.slice(1).join(' ');
  if (toks.length === 1) return toks[0];
  // Series read best on the familiar first name (Kendall, Abed, Cassian);
  // movies read best on the surname (Einstein, Stark, Oppenheimer).
  return kind === 'movie' ? toks[toks.length - 1] : toks[0];
}

/**
 * Turn a TMDB character string into { name, display, aliases }.
 *   "Siobhan 'Shiv' Roy"   -> name kept, display "Shiv"
 *   "Tony Stark / Iron Man"-> name "Tony Stark", alias "Iron Man", display "Stark" (movie)
 *   "B2EMO (voice)"        -> "B2EMO"
 *   "Supervisor Lagret"    -> display "Lagret"
 */
export function parseCharacter(raw, kind = 'series') {
  const cleaned = String(raw || '')
    .replace(/\((?:voice|uncredited|credited|cameo|archive footage)[^)]*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || NOT_A_CHARACTER.some((re) => re.test(cleaned))) return null;
  const parts = cleaned.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  const name = parts[0];
  const aliases = new Set(parts.slice(1));
  // Quoted nicknames inside the name, e.g. Siobhan 'Shiv' Roy
  for (const m of name.matchAll(/['"‘’“”]([^'"‘’“”]{2,30})['"‘’“”]/g)) aliases.add(m[1].trim());
  const plain = name.replace(/['"‘’“”]/g, '').replace(/\s+/g, ' ').trim();
  const quoted = aliases.size
    ? [...aliases].filter((a) => a.length >= 2 && plain.toLowerCase().includes(a.toLowerCase()))[0]
    : null;
  const display = displayFor(plain, quoted, kind);
  return {
    name: name.replace(/\s+/g, ' ').trim() || plain,
    display,
    aliases: [...aliases].filter((a) => a && a.toLowerCase() !== display.toLowerCase())
  };
}

/**
 * Fetch cast credits and store them as this title's canonical character list.
 * Series use aggregate_credits (whole-run cast, episodes>=5, ranked); movies use
 * credits (billing order). Titles without cast (documentaries) end up with an
 * empty list, and the naming stage then behaves as before.
 * Returns the number of characters stored.
 */
export async function syncCharacters(t, { topN = 25 } = {}) {
  if (!t.tmdb_id) return 0;
  const data = t.kind === 'series'
    ? await get(`/tv/${t.tmdb_id}/aggregate_credits`)
    : await get(`/movie/${t.tmdb_id}/credits`);
  const cast = data.cast || [];
  const rows = (t.kind === 'series'
    ? cast.filter((c) => (c.total_episode_count || 0) >= 5)
        .sort((a, b) => (b.total_episode_count || 0) - (a.total_episode_count || 0))
        .slice(0, topN)
        .map((c) => ({ raw: c.roles?.[0]?.character || c.name, eps: c.total_episode_count || 0 }))
    : cast.slice(0, topN).map((c) => ({ raw: c.character || c.name, eps: 1 }))
  ).map((r) => ({ ...r, parsed: parseCharacter(r.raw, t.kind) }))
   .filter((r) => r.parsed);

  // Two characters sharing a short display ("Kendall" twice) would produce
  // ambiguous cues — those fall back to the full name.
  const byDisplay = new Map();
  for (const r of rows) {
    const k = r.parsed.display.toLowerCase();
    byDisplay.set(k, (byDisplay.get(k) || 0) + 1);
  }
  for (const r of rows) {
    if (byDisplay.get(r.parsed.display.toLowerCase()) > 1) r.parsed.display = r.parsed.name;
  }

  // Hand-edited rows (source='manual') win: they survive a refresh untouched.
  const manual = new Set(
    db.prepare(`SELECT name FROM title_characters WHERE title_id=? AND source='manual'`).all(t.id)
      .map((r) => r.name.toLowerCase())
  );
  db.prepare(`DELETE FROM title_characters WHERE title_id=? AND source='tmdb'`).run(t.id);
  const seen = new Set();
  let stored = 0;
  for (const r of rows) {
    const key = r.parsed.name.toLowerCase();
    if (seen.has(key) || manual.has(key)) continue;
    seen.add(key);
    q.upsertCharacter.run({
      title_id: t.id,
      name: r.parsed.name,
      display: r.parsed.display,
      aliases: JSON.stringify(r.parsed.aliases),
      episodes: r.eps,
      source: 'tmdb'
    });
    stored++;
  }
  return stored;
}

/**
 * Cast credited in one episode: the series regulars who appear plus that
 * episode's guest stars. Cached in episode_characters so transcription stays
 * offline. The whole-run cast misses one-episode characters (a guest professor,
 * a defendant), and forcing the model to pick from it is what produced
 * confidently wrong names like "Buzz Hickey" in season 1.
 */
export async function syncEpisodeCharacters(t, season, episode, { refresh = false } = {}) {
  if (!t.tmdb_id || season == null || episode == null) return 0;
  if (!refresh && q.countEpisodeCharacters.get(t.id, season, episode).n) {
    return q.countEpisodeCharacters.get(t.id, season, episode).n;
  }
  const data = await get(`/tv/${t.tmdb_id}/season/${season}/episode/${episode}/credits`);

  // Hand-edited names from title_characters win, and existing aliases are
  // merged in (the episode credit often uses the long form of a character).
  const series = new Map(q.charactersForTitle.all(t.id).map((c) => [c.name.toLowerCase(), c]));
  const manual = new Map([...series.values()]
    .filter((c) => c.source === 'manual')
    .map((c) => [c.name.toLowerCase(), c]));

  const people = [
    ...(data.cast || []).map((p) => ({ p, regular: true })),
    ...(data.guest_stars || []).map((p) => ({ p, regular: false }))
  ];
  const rows = new Map();
  for (const { p, regular } of people) {
    const parsed = parseCharacter(p.character || p.name, t.kind);
    if (!parsed) continue;
    const key = parsed.name.toLowerCase();
    const seriesRow = series.get(key);
    const manualRow = manual.get(key);
    const aliases = new Set([
      ...parsed.aliases,
      ...JSON.parse((seriesRow && seriesRow.aliases) || '[]'),
      ...JSON.parse((manualRow && manualRow.aliases) || '[]')
    ]);
    aliases.delete(parsed.display);
    const prev = rows.get(key);
    rows.set(key, {
      title_id: t.id, season, episode,
      name: parsed.name,
      display: (manualRow && manualRow.display) || parsed.display,
      aliases: JSON.stringify([...aliases]),
      regular: ((prev && prev.regular) || regular) ? 1 : 0,
      source: 'tmdb'
    });
  }
  q.clearEpisodeCharacters.run(t.id, season, episode);
  for (const r of rows.values()) q.upsertEpisodeCharacter.run(r);
  return rows.size;
}

/** Fill episode_characters for every episodic file that has a TMDB id. */
export async function syncAllEpisodeCharacters({ refresh = false, only = null } = {}) {
  let titles = q.allTitles.all().filter((t) => t.kind === 'series' && t.tmdb_id);
  if (only) titles = titles.filter((t) => t.name.toLowerCase().includes(only.toLowerCase()));
  let episodes = 0, chars = 0, skipped = 0, fail = 0;
  for (const t of titles) {
    const eps = db.prepare(`SELECT DISTINCT season, episode FROM files
      WHERE title_id=? AND kind='episode' AND season IS NOT NULL AND episode IS NOT NULL AND hidden=0
      ORDER BY season, episode`).all(t.id);
    for (const { season, episode } of eps) {
      if (!refresh && q.countEpisodeCharacters.get(t.id, season, episode).n) { skipped++; continue; }
      try {
        const n = await syncEpisodeCharacters(t, season, episode, { refresh });
        if (n) { episodes++; chars += n; }
        else skipped++;
      } catch (e) {
        fail++;
        console.log(`ERROR ${t.name} S${season}E${episode} — ${e.message}`);
      }
    }
    console.log(`episode cast: ${t.name} — ${eps.length} episode(s)`);
  }
  return { episodes, chars, skipped, fail, titles: titles.length };
}

export async function syncSeries(t) {
  const search = await get('/search/tv', { query: t.name });
  const results = search.results || [];
  if (!results.length) return false;
  const best = results
    .map((r) => ({ r, score: nameSimilarity(r.name, t.name) + (r.first_air_date?.startsWith(String(t.year || '')) ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score)[0].r;

  const detail = await get(`/tv/${best.id}`);
  const poster = best.poster_path ? await download(`${IMG}/w500${best.poster_path}`, imgName(best.id, 'poster', 'w500', 'a.jpg')) : null;
  const backdrop = best.backdrop_path ? await download(`${IMG}/w1280${best.backdrop_path}`, imgName(best.id, 'back', 'w1280', 'a.jpg')) : null;

  const year = best.first_air_date ? parseInt(best.first_air_date.slice(0, 4), 10) : null;
  q.updateTitleMeta.run({
    id: t.id, name: best.name, year,
    overview: best.overview || null,
    poster: poster || null, backdrop: backdrop || null, tmdb_id: best.id
  });


  // Episode metadata for every season we actually have files for
  const seasons = db.prepare(`SELECT DISTINCT season FROM files WHERE title_id=? AND kind='episode' AND season IS NOT NULL AND hidden=0`).all(t.id);
  for (const { season } of seasons) {
    let sdata;
    try { sdata = await get(`/tv/${best.id}/season/${season}`); } catch { continue; }
    for (const ep of sdata.episodes || []) {
      const still = ep.still_path ? await download(`${IMG}/w300${ep.still_path}`, imgName(ep.id, 'still', 'w300', 'a.jpg')) : null;
      db.prepare(`UPDATE files SET ep_name=?, ep_overview=?, ep_still=? WHERE title_id=? AND season=? AND episode=?`)
        .run(ep.name || null, ep.overview || null, still, t.id, season, ep.episode_number);
    }
  }
  // Cast for speaker naming. Optional: a failure here must not fail the sync.
  try { await syncCharacters({ id: t.id, kind: 'series', tmdb_id: best.id }); } catch { /* no cast */ }
  // Per-episode cast (regulars + guest stars) for accurate speaker naming.
  try { await syncAllEpisodeCharacters({ only: t.name }); } catch { /* no episode credits */ }
  return true;
}

export async function syncMovie(t) {
  const search = await get('/search/movie', { query: t.name, year: t.year || undefined });
  const results = search.results || [];
  if (!results.length) return false;
  const best = results
    .map((r) => ({ r, score: nameSimilarity(r.title, t.name) + (r.release_date?.startsWith(String(t.year || '')) ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score)[0].r;
  const poster = best.poster_path ? await download(`${IMG}/w500${best.poster_path}`, imgName(best.id, 'poster', 'w500', 'a.jpg')) : null;
  const backdrop = best.backdrop_path ? await download(`${IMG}/w1280${best.backdrop_path}`, imgName(best.id, 'back', 'w1280', 'a.jpg')) : null;
  const year = best.release_date ? parseInt(best.release_date.slice(0, 4), 10) : null;
  q.updateTitleMeta.run({
    id: t.id, name: best.title, year,
    overview: best.overview || null,
    poster: poster || null, backdrop: backdrop || null, tmdb_id: best.id
  });
  try { await syncCharacters({ id: t.id, kind: 'movie', tmdb_id: best.id }); } catch { /* no cast */ }
  return true;
}

/** Fill title_characters for every title that has a TMDB id (cast only, no posters). */
export async function syncAllCharacters({ refresh = false, topN = 25 } = {}) {
  const titles = q.allTitles.all().filter((t) => t.tmdb_id);
  let ok = 0, empty = 0, fail = 0, chars = 0;
  for (const t of titles) {
    const has = db.prepare(`SELECT COUNT(*) n FROM title_characters WHERE title_id=?`).get(t.id).n;
    if (has && !refresh) { ok++; continue; }
    try {
      const n = await syncCharacters(t, { topN });
      if (n) { ok++; chars += n; console.log(`cast ${t.kind}: ${t.name} — ${n} character(s)`); }
      else { empty++; console.log(`NO CAST ${t.kind}: ${t.name}`); }
    } catch (e) {
      fail++; console.log(`ERROR ${t.kind}: ${t.name} - ${e.message}`);
    }
  }
  return { ok, empty, fail, chars, total: titles.length };
}

export async function syncAll() {
  const titles = q.allTitles.all().filter((t) => !t.tmdb_synced);
  let ok = 0, fail = 0;
  for (const t of titles) {
    try {
      const done = t.kind === 'series' ? await syncSeries(t) : await syncMovie(t);
      if (done) { ok++; console.log(`synced ${t.kind}: ${t.name}`); }
      else { fail++; console.log(`NO MATCH ${t.kind}: ${t.name}`); }
    } catch (e) {
      fail++; console.log(`ERROR ${t.kind}: ${t.name} - ${e.message}`);
    }
  }
  return { ok, fail, total: titles.length };
}
