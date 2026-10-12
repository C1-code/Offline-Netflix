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
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`TMDB ${res.status} for ${pathname}`);
  return res.json();
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
  return true;
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
