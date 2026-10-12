import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { db, q } from './db.js';
import {
  parseMediaPath, isVideoFile, looksLikeJunkFile, looksLikeSeasonFolder,
  looksLikeExtrasFolder, cleanName, extractYear, titleCase
} from './clean.js';
import { probeVideo } from './probe.js';
import { harvestExternalSubs } from './subtitles.js';

const SAMPLE_RE = /(^|[.\-_ ])(sample|trailer)([.\-_ ]|$)/i;

export function walkVideos(root) {
  const out = [];
  const walk = (dir, relParts) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, [...relParts, e.name]);
      else if (e.isFile() && isVideoFile(e.name) && !looksLikeJunkFile(e.name) && !SAMPLE_RE.test(e.name)) {
        out.push({ abs: p, relParts, filename: e.name, size: sizeOf(p) });
      }
    }
  };
  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
  walk(root, []);
  return out;
}

const tokenSet = (s) => new Set(String(s || '').toLowerCase().split(/\s+/).filter(Boolean));

// Deepest ancestor folder that plausibly names the show: prefer one that
// shares a token with the file's own pre-marker title (handles collection
// folders like Marvel/Doomsday sitting above release-style show folders).
function resolveShow(relParts, filename, marker) {
  const pre = marker ? String(filename).slice(0, marker.index) : filename;
  const preTokens = tokenSet(cleanName(pre) + ' ' + cleanName(filename));
  let fallback = null;
  for (let i = relParts.length - 1; i >= 0; i--) {
    const part = relParts[i];
    if (looksLikeSeasonFolder(part) || looksLikeExtrasFolder(part)) continue;
    let cleaned = cleanName(part);
    if (!cleaned || cleaned.length < 2) continue;
    cleaned = cleaned.replace(/\s+S\d{1,2}$/i, '').trim();   // "Loki S01" -> "Loki"
    if (!fallback) fallback = { name: cleaned, year: extractYear(part) };
    const toks = tokenSet(cleaned);
    for (const t of toks) {
      if (preTokens.has(t) && t.length >= 3) return { name: cleaned, year: extractYear(part) };
    }
  }
  return fallback;
}

function resolveExtrasShow(relParts) {
  for (let i = relParts.length - 1; i >= 0; i--) {
    const part = relParts[i];
    if (looksLikeSeasonFolder(part) || looksLikeExtrasFolder(part)) continue;
    const cleaned = cleanName(part);
    if (cleaned && cleaned.length >= 2) return cleaned;
  }
  return null;
}

function findSeries(name) {
  const row = db.prepare(`SELECT * FROM titles WHERE kind='series' AND name = ? COLLATE NOCASE AND hidden = 0`).get(name);
  return row || null;
}

function findMovie(name, year) {
  const row = year != null
    ? db.prepare(`SELECT * FROM titles WHERE kind='movie' AND name = ? COLLATE NOCASE AND (year = ? OR year IS NULL) AND hidden = 0`).get(name, year)
    : db.prepare(`SELECT * FROM titles WHERE kind='movie' AND name = ? COLLATE NOCASE AND year IS NULL AND hidden = 0`).get(name);
  return row || null;
}

const insertTitle = db.prepare(`INSERT INTO titles (kind, name, sort_name, year, folder) VALUES (?,?,?,?,?)`);
const sortKey = (s) => String(s || '').replace(/^(the|a|an)\s+/i, '').toLowerCase();

const insertFile = db.prepare(`INSERT INTO files (title_id, path, filename, ext, size, kind, season, episode, ep_name)
  VALUES (@title_id, @path, @filename, @ext, @size, @kind, @season, @episode, @ep_name)`);
const setFolder = db.prepare(`UPDATE titles SET folder = ? WHERE id = ?`);

export async function scan({ probe = true, subs = true } = {}) {
  const root = cfg.mediaPath;
  if (!fs.existsSync(root)) throw new Error('media path does not exist: ' + root);
  const videos = walkVideos(root);

  const existing = new Map(q.allFiles.all().map((f) => [f.path, f.id]));
  const seen = new Set();
  let skipped = 0;

  for (const v of videos) {
    seen.add(v.abs);
    if (existing.has(v.abs)) {
      db.prepare(`UPDATE files SET size=? WHERE id=?`).run(v.size, existing.get(v.abs));
      continue;
    }
    const parsed = parseMediaPath(v.relParts, v.filename);
    const ext = path.extname(v.filename).slice(1).toLowerCase();
    const base = { path: v.abs, filename: v.filename, ext, size: v.size };

    if (parsed.kind === 'junk' || SAMPLE_RE.test(v.filename)) { skipped++; continue; }

    let titleRow = null;
    if (parsed.kind === 'episode') {
      titleRow = findSeries(parsed.showName);
      if (!titleRow) {
        insertTitle.run('series', parsed.showName, sortKey(parsed.showName), null, v.relParts[0] || null);
        titleRow = findSeries(parsed.showName);
      }
      setFolder.run(v.relParts[0] || null, titleRow.id);
      insertFile.run({
        ...base, title_id: titleRow.id, kind: 'episode',
        season: parsed.season, episode: parsed.episode, ep_name: parsed.epNameGuess || `Episode ${parsed.episode}`
      });
    } else if (parsed.kind === 'extra') {
      const showName = resolveExtrasShow(v.relParts);
      if (!showName) { skipped++; continue; }
      titleRow = findSeries(showName);
      if (!titleRow) {
        insertTitle.run('series', showName, sortKey(showName), null, v.relParts[0] || null);
        titleRow = findSeries(showName);
      }
      insertFile.run({
        ...base, title_id: titleRow.id, kind: 'extra',
        season: null, episode: null, ep_name: cleanName(v.filename.replace(/\.[^.]+$/, '')) || v.filename
      });
    } else {
      // Movie: strip a trailing year from the name (it lives in the year column)
      let name = parsed.movieName;
      let year = parsed.year;
      if (year != null && new RegExp(`\\s*\\(?${year}\\)?$`).test(name)) {
        name = name.replace(new RegExp(`\\s*\\(?${year}\\)?$`), '').trim();
      }
      titleRow = findMovie(name, year);
      if (!titleRow) {
        insertTitle.run('movie', name, sortKey(name), year, v.relParts[0] || null);
        titleRow = findMovie(name, year);
      }
      setFolder.run(v.relParts[0] || null, titleRow.id);
      insertFile.run({ ...base, title_id: titleRow.id, kind: 'movie', season: null, episode: null, ep_name: null });
    }
  }

  // Remove DB rows for files that vanished
  let removed = 0;
  for (const [p, id] of existing) {
    if (!seen.has(p)) { q.deleteFile.run(id); removed++; }
  }

  // Hide duplicate copies: same movie title or same series+season+episode; keep the largest file
  const dupHide = db.prepare(`UPDATE files SET hidden = 1 WHERE id = ?`);
  const dupNote = db.prepare(`UPDATE titles SET dup_note = ? WHERE id = ?`);
  let dupes = 0;
  const movieTitles = q.titlesByKind.all('movie');
  for (const t of movieTitles) {
    const fs_ = db.prepare(`SELECT * FROM files WHERE title_id = ? ORDER BY size DESC`).all(t.id);
    if (fs_.length > 1) {
      for (let i = 1; i < fs_.length; i++) { dupHide.run(fs_[i].id); dupes++; }
      dupNote.run(`${fs_.length - 1} duplicate file(s) hidden (kept largest: ${path.basename(fs_[0].path)})`, t.id);
    }
  }
  const seriesTitles = q.titlesByKind.all('series');
  for (const t of seriesTitles) {
    const rows = db.prepare(`SELECT * FROM files WHERE title_id = ? AND kind='episode' ORDER BY size DESC`).all(t.id);
    const byEp = new Map();
    for (const r of rows) {
      const k = `${r.season}x${String(r.episode).padStart(3, '0')}`;
      if (byEp.has(k)) { dupHide.run(r.id); dupes++; }
      else byEp.set(k, r);
    }
  }

  // Probe durations/dimensions (parallel, skipped when already done)
  let probed = 0;
  if (probe) {
    const toProbe = q.allFiles.all().filter((f) => !f.probe_done && fs.existsSync(f.path));
    const CONC = 8;
    let idx = 0;
    async function worker() {
      while (idx < toProbe.length) {
        const f = toProbe[idx++];
        try {
          const info = await probeVideo(f.path);
          q.updateFileProbe.run({ id: f.id, duration: info.duration, width: info.width, height: info.height });
          probed++;
        } catch { /* unreadable file; leave probe_done=0 */ }
      }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
  }

  let subMatch = null;
  if (subs) subMatch = harvestExternalSubs();

  return {
    videos: videos.length, skipped, removed, dupes, probed,
    movies: q.titlesByKind.all('movie').length,
    series: q.titlesByKind.all('series').length,
    files: q.countFiles.get().n,
    subs: subMatch
  };
}
