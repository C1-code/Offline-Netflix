import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, 'config.json');

const defaults = {
  mediaPath: '/mnt/c/Users/elias/Desktop/Media',
  port: 8420,
  tmdbApiKey: '',
  tmdbLanguage: 'en',
  whisperModel: 'large-v3-turbo',
  whisperLanguage: 'auto',
  transcodeEnabled: true
};

let cfg = { ...defaults };
try {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg = { ...defaults, ...raw };
} catch {
  // fall back to defaults; config.json written at setup
}

cfg.root = ROOT;
cfg.dataDir = path.join(ROOT, 'data');
cfg.dbPath = path.join(cfg.dataDir, 'library.db');
cfg.imagesDir = path.join(cfg.dataDir, 'images');
cfg.subsCacheDir = path.join(cfg.dataDir, 'subs-cache');
cfg.thumbsDir = path.join(cfg.dataDir, 'thumbs');
cfg.venvPython = path.join(ROOT, 'tools', '.venv', 'bin', 'python');

for (const d of [cfg.dataDir, cfg.imagesDir, cfg.subsCacheDir, cfg.thumbsDir]) {
  fs.mkdirSync(d, { recursive: true });
}

export default cfg;
