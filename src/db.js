import Database from 'better-sqlite3';
import cfg from './config.js';

export const db = new Database(cfg.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');


// --- lightweight migrations ---
{
  const cols = db.prepare(`PRAGMA table_info(files)`).all().map((c) => c.name);
  if (!cols.includes('vcodec')) db.exec(`ALTER TABLE files ADD COLUMN vcodec TEXT`);
  if (!cols.includes('acodec')) db.exec(`ALTER TABLE files ADD COLUMN acodec TEXT`);
  if (!cols.includes('vcodec_str')) db.exec(`ALTER TABLE files ADD COLUMN vcodec_str TEXT`);
  if (!cols.includes('acodec_str')) db.exec(`ALTER TABLE files ADD COLUMN acodec_str TEXT`);
}
db.exec(`
CREATE TABLE IF NOT EXISTS titles (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,               -- 'movie' | 'series'
  name TEXT NOT NULL,
  sort_name TEXT,
  year INTEGER,
  folder TEXT,                      -- top-level collection folder (for browsing)
  tmdb_id INTEGER,
  overview TEXT,
  poster TEXT,
  backdrop TEXT,
  tmdb_synced INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,         -- duplicate / superseded entry
  dup_note TEXT,
  UNIQUE(kind, name, year)
);


CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  title_id INTEGER NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  path TEXT UNIQUE NOT NULL,
  filename TEXT,
  ext TEXT,
  size INTEGER,
  duration REAL,
  width INTEGER,
  height INTEGER,
  kind TEXT NOT NULL,               -- 'movie' | 'episode' | 'extra'
  season INTEGER,
  episode INTEGER,
  ep_name TEXT,
  ep_overview TEXT,
  ep_still TEXT,
  thumb TEXT,
  probe_done INTEGER DEFAULT 0,
  hidden INTEGER DEFAULT 0,                -- duplicate copy of the same content
  subtitle_status TEXT DEFAULT 'pending',  -- pending | extracting | waiting | transcribing | done | failed
  added_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_files_title ON files(title_id);
CREATE INDEX IF NOT EXISTS idx_files_kind ON files(kind);

CREATE TABLE IF NOT EXISTS progress (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  position REAL DEFAULT 0,
  duration REAL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS subtracks (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  lang TEXT,
  label TEXT,
  source TEXT,                      -- embedded | external | whisper
  format TEXT,                      -- srt | vtt | ass
  UNIQUE(file_id, path)
);

CREATE TABLE IF NOT EXISTS rename_log (
  id INTEGER PRIMARY KEY,
  old_path TEXT NOT NULL,
  new_path TEXT NOT NULL,
  applied_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

export const q = {
  getTitle: db.prepare(`SELECT * FROM titles WHERE id = ?`),
  getTitleByUnique: db.prepare(`SELECT * FROM titles WHERE kind = ? AND name = ? AND (year IS ? OR year = ?)`),
  allTitles: db.prepare(`SELECT * FROM titles WHERE hidden = 0 ORDER BY sort_name`),
  titlesByKind: db.prepare(`SELECT * FROM titles WHERE hidden = 0 AND kind = ? ORDER BY sort_name`),
  insertTitle: db.prepare(`INSERT OR IGNORE INTO titles (kind, name, sort_name, year, folder) VALUES (?,?,?,?,?)`),
  updateTitleMeta: db.prepare(`UPDATE titles SET name=@name, year=@year, overview=@overview, poster=@poster, backdrop=@backdrop, tmdb_id=@tmdb_id, tmdb_synced=1 WHERE id=@id`),
  setFolder: db.prepare(`UPDATE titles SET folder=? WHERE id=?`),
  deleteTitle: db.prepare(`DELETE FROM titles WHERE id = ?`),

  allFiles: db.prepare(`SELECT * FROM files`),
  filesOfTitle: db.prepare(`SELECT * FROM files WHERE title_id = ? AND hidden = 0 ORDER BY COALESCE(season,0), episode, filename`),
  fileByPath: db.prepare(`SELECT * FROM files WHERE path = ?`),
  fileById: db.prepare(`SELECT * FROM files WHERE id = ?`),
  insertFile: db.prepare(`INSERT INTO files (title_id, path, filename, ext, size, kind, season, episode, ep_name) VALUES (@title_id,@path,@filename,@ext,@size,@kind,@season,@episode,@ep_name)`),
  updateFileProbe: db.prepare(`UPDATE files SET duration=@duration, width=@width, height=@height, vcodec=@vcodec, acodec=@acodec, vcodec_str=@vcodec_str, acodec_str=@acodec_str, probe_done=1 WHERE id=@id`),
  updateEpMeta: db.prepare(`UPDATE files SET ep_name=@ep_name, ep_overview=@ep_overview, ep_still=@ep_still WHERE id=@id`),
  setThumb: db.prepare(`UPDATE files SET thumb=@thumb WHERE id=@id`),
  deleteFile: db.prepare(`DELETE FROM files WHERE id = ?`),
  countFiles: db.prepare(`SELECT COUNT(*) AS n FROM files`),

  dupSeriesCheck: db.prepare(`SELECT * FROM titles WHERE kind='series' AND name=? AND year IS NULL AND hidden=0`),
  setDupKey: db.prepare(`UPDATE titles SET dup_note=@note WHERE id=@id`),
  setTitleHidden: db.prepare(`UPDATE titles SET hidden=1, dup_note=@note WHERE id=@id`),

  getProgress: db.prepare(`SELECT * FROM progress WHERE file_id = ?`),
  setProgress: db.prepare(`INSERT INTO progress (file_id, position, duration, updated_at) VALUES (@file_id,@position,@duration,@updated_at)
    ON CONFLICT(file_id) DO UPDATE SET position=@position, duration=@duration, updated_at=@updated_at`),
  deleteProgress: db.prepare(`DELETE FROM progress WHERE file_id = ?`),
  continueWatching: db.prepare(`
    SELECT p.*, f.*, t.kind AS t_kind, t.name AS t_name, t.year AS t_year, t.poster AS t_poster,
           (p.position * 1.0 / NULLIF(p.duration,0)) AS frac
    FROM progress p
    JOIN files f ON f.id = p.file_id
    JOIN titles t ON t.id = f.title_id
    WHERE f.hidden = 0 AND p.position > 5 AND p.duration > 0 AND (p.position / p.duration) < 0.97
    ORDER BY p.updated_at DESC LIMIT 20`),

  subtracksOfFile: db.prepare(`SELECT * FROM subtracks WHERE file_id = ?`),
  addSubtrack: db.prepare(`INSERT OR IGNORE INTO subtracks (file_id, path, lang, label, source, format) VALUES (@file_id,@path,@lang,@label,@source,@format)`),
  clearSubtracks: db.prepare(`DELETE FROM subtracks WHERE file_id = ?`),
  subtrackById: db.prepare(`SELECT * FROM subtracks WHERE id = ?`),
  filesNeedingSubs: db.prepare(`
    SELECT f.* FROM files f
    WHERE f.subtitle_status IN ('pending','failed')
      AND f.kind != 'extra'
    ORDER BY f.size DESC`),

  renameLogInsert: db.prepare(`INSERT INTO rename_log (old_path, new_path) VALUES (?,?)`),
  renameLogAll: db.prepare(`SELECT * FROM rename_log ORDER BY id`),

  setSetting: db.prepare(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`)
};
