import fs from 'node:fs';
import path from 'node:path';
import cfg from './config.js';
import { db, q } from './db.js';
import { looksLikeSeasonFolder, seasonNumberFromFolder, isSubFile } from './clean.js';

// Windows-legal file name
export function sanitize(name) {
  let s = String(name).replace(/[<>:"/\\|?*]/g, ' - ').replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[.\s]+$/, '');
  return s;
}

const COMPANION_EXTS = new Set(['.srt', '.ass', '.ssa', '.vtt', '.nfo']);
const SHOW = db.prepare(`SELECT * FROM titles WHERE id = ?`);

function showBase(f) {
  const t = SHOW.get(f.title_id);
  return sanitize(t ? t.name : 'Unknown');
}

function movieBase(f) {
  const t = SHOW.get(f.title_id);
  const year = t && t.year ? ` (${t.year})` : '';
  return sanitize((t ? t.name : 'Unknown') + year);
}

function companionMoves(f, oldPath, newPath) {
  const dir = path.dirname(oldPath);
  const base = path.basename(oldPath, path.extname(oldPath));
  const newBase = path.basename(newPath, path.extname(newPath));
  const moves = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return moves; }
  for (const e of entries) {
    const ext = path.extname(e).toLowerCase();
    if (!COMPANION_EXTS.has(ext)) continue;
    if (!e.startsWith(base)) continue;
    const rest = e.slice(base.length);
    if (rest && !/^\.[a-z]{2,3}(\.forced|\.sdh)?$/i.test(rest) && !isSubFile(e)) continue;
    const to = path.join(dir, `${newBase}${rest}${ext}`);
    if (to !== path.join(dir, e)) moves.push({ type: 'companion', from: path.join(dir, e), to });
  }
  return moves;
}

// Build the one-time rename plan: {files: [...], folders: [...]}
export function buildPlan() {
  const fileMoves = [];
  const files = q.allFiles.all().filter((f) => !f.hidden);

  for (const f of files) {
    if (f.kind === 'extra') continue;                 // extras left in place
    const dir = path.dirname(f.path);
    const ext = path.extname(f.path);
    let target;
    if (f.kind === 'episode') {
      const epName = f.ep_name && !/^(?:Episode|Extra)\s*\d+$/i.test(f.ep_name)
        ? f.ep_name : `Episode ${f.episode}`;
      const epTag = `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`;
      target = path.join(dir, sanitize(`${showBase(f)} - ${epTag} - ${epName}${ext}`));
    } else {
      target = path.join(dir, `${movieBase(f)}${ext}`);
    }
    if (f.path !== target) {
      fileMoves.push({ type: 'file', id: f.id, from: f.path, to: target, ...companionMoves(f, f.path, target).reduce((a, m) => a, {}) });
      fileMoves.push(...companionMoves(f, f.path, target));
    }
  }

  // Folder renames for TV: "Season 1 (BluRay)" -> "Season 1" when already under
  // the show folder; release-style episode folders -> "<Show> - Season N".
  const folderMoves = [];
  const dirsToRename = new Map();   // dir -> {season, showTitleId}
  for (const f of files) {
    if (f.kind !== 'episode') continue;
    const dir = path.dirname(f.path);
    const cur = dirsToRename.get(dir) || { season: null, titleId: f.title_id };
    if (cur.season == null || f.season < cur.season) cur.season = f.season;
    dirsToRename.set(dir, cur);
  }
  for (const [dir, info] of dirsToRename) {
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    const show = SHOW.get(info.titleId);
    const showName = show ? show.name : null;
    const parentIsShow = path.basename(parent).toLowerCase() === String(showName || '').toLowerCase();
    // "Season 1 (BluRay)" directly under the show folder -> "Season 1";
    // anything else (release-style or show-prefixed folders) -> "<Show> - Season N"
    const targetName = info.season === 0
      ? 'Specials'
      : looksLikeSeasonFolder(base) && parentIsShow
        ? `Season ${info.season}`
        : `${showName || base} - Season ${info.season}`;
    if (base === targetName) continue;
    const to = path.join(parent, sanitize(targetName));
    if (fs.existsSync(to)) continue;   // avoid collisions
    folderMoves.push({ type: 'folder', from: dir, to });
  }
  // deepest-first so nested renames stay valid
  folderMoves.sort((a, b) => b.from.length - a.from.length);
  return { fileMoves, folderMoves };
}

export function applyPlan(plan) {
  const log = db.prepare(`INSERT INTO rename_log (old_path, new_path) VALUES (?,?)`);
  const setFilePath = db.prepare(`UPDATE files SET path=? WHERE id=?`);
  const fixSubPath = db.prepare(`UPDATE subtracks SET path=? WHERE file_id=? AND path=?`);
  let applied = 0, failed = [];

  for (const m of plan.fileMoves) {
    try {
      if (fs.existsSync(m.to)) throw new Error('target exists');
      fs.renameSync(m.from, m.to);
      if (m.type === 'file') {
        setFilePath.run(m.to, m.id);
      }
      // companion/subtrack paths: repoint any DB row that referenced the old path
      db.prepare(`UPDATE subtracks SET path=? WHERE path=?`).run(m.to, m.from);
      log.run(m.from, m.to);
      applied++;
    } catch (e) {
      failed.push({ from: m.from, to: m.to, error: e.message });
    }
  }

  for (const m of plan.folderMoves) {
    try {
      if (fs.existsSync(m.to)) throw new Error('target exists');
      fs.renameSync(m.from, m.to);
      // repoint every DB path that lived under the old folder
      const rows = db.prepare(`SELECT id, path FROM files WHERE path LIKE ?`).all(m.from + path.sep + '%');
      for (const r of rows) {
        const np = m.to + r.path.slice(m.from.length);
        db.prepare(`UPDATE files SET path=? WHERE id=?`).run(np, r.id);
        db.prepare(`UPDATE subtracks SET path=? WHERE path=?`).run(np, r.path);
      }
      const subs = db.prepare(`SELECT id, file_id, path FROM subtracks WHERE path LIKE ?`).all(m.from + path.sep + '%');
      for (const s of subs) {
        db.prepare(`UPDATE subtracks SET path=? WHERE id=?`).run(m.to + s.path.slice(m.from.length), s.id);
      }
      log.run(m.from, m.to);
      applied++;
    } catch (e) {
      failed.push({ from: m.from, to: m.to, error: e.message });
    }
  }
  return { applied, failed };
}
