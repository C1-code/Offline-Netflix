import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_PATH = path.join(ROOT, 'config.json');

const defaults = {
  mediaPath: '',        // empty = auto-detect for this machine (see detectMediaPath)
  port: 8420,
  tmdbApiKey: '',
  tmdbLanguage: 'en',
  whisperModel: 'large-v3-turbo',
  whisperLanguage: 'auto',
  subsDiarize: true,             // speaker-labeled, character-named cues (see transcribe.py --diarize)
  whisperHfToken: '',            // Hugging Face token, one-time (pyannote gated model)
  ollamaHost: 'http://127.0.0.1:11434',
  subsNamingModel: '',           // empty = transcribe.py default ('qwen3:4b')
  transcodeEnabled: true,
  autoScanMinutes: 5,    // 0 = disable automatic library scanning
  venvPython: '',        // resolved below by detectWhisper()
  whisperAvailable: false
};
let rawCfg = {};
let cfg = { ...defaults };
try {
  rawCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg = { ...defaults, ...rawCfg };
} catch {
  // fall back to defaults; config.json written at setup
}

// ---- Machine detection -----------------------------------------------------
// The same repo should work on the WSL desktop, a laptop, or inside Docker
// without editing anything. Resolution order for every machine-specific value:
//   1. environment variable (set by docker-compose / .env)
//   2. config.json (per-machine, gitignored)
//   3. auto-detection of whatever this machine actually has

function applyEnv() {
  if (process.env.MEDIA_PATH) cfg.mediaPath = process.env.MEDIA_PATH;
  if (process.env.PORT) cfg.port = parseInt(process.env.PORT, 10) || cfg.port;
  if (process.env.TMDB_API_KEY) cfg.tmdbApiKey = process.env.TMDB_API_KEY;
  if (process.env.HF_TOKEN) cfg.whisperHfToken = process.env.HF_TOKEN;
  if (process.env.WHISPER_PYTHON) {
    cfg.venvPython = process.env.WHISPER_PYTHON;
    cfg.whisperAvailable = true;
  }
}

function detectMediaPath() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Media'), path.join(home, 'Videos'), path.join(home, 'Movies'),
    path.join(ROOT, 'media')
  ];
  if (process.platform === 'win32' && process.env.USERPROFILE) {
    candidates.push(
      path.join(process.env.USERPROFILE, 'Desktop', 'Media'),
      path.join(process.env.USERPROFILE, 'Videos')
    );
  }
  try { // WSL: any Windows user profile's Desktop/Media
    for (const u of fs.readdirSync('/mnt/c/Users', { withFileTypes: true })) {
      if (u.isDirectory() && !/^(Public|Default|Default User|All Users)$/.test(u.name)) {
        candidates.push(path.join('/mnt/c/Users', u.name, 'Desktop', 'Media'));
      }
    }
  } catch { /* not WSL */ }
  for (const p of candidates) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* keep looking */ }
  }
  return '';
}

function detectWhisper() {
  const py = process.platform === 'win32'
    ? path.join(ROOT, 'tools', '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, 'tools', '.venv', 'bin', 'python');
  cfg.venvPython = py;
  cfg.whisperAvailable = fs.existsSync(py);
}

if (!cfg.mediaPath) {
  cfg.mediaPath = detectMediaPath();
  if (cfg.mediaPath) console.log(`[config] auto-detected media folder: ${cfg.mediaPath}`);
}
detectWhisper();
applyEnv();

// Persist user-editable settings back to config.json and refresh the shared
// in-memory cfg (used by the settings page; changes apply without restart,
// except port which is read once at listen time). Env vars stay authoritative
// on top so a container can't have its config silently overridden.
export function saveConfig(updates) {
  rawCfg = { ...rawCfg, ...updates };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(rawCfg, null, 2) + '\n');
  Object.assign(cfg, updates);
  applyEnv();
}
cfg.root = ROOT;
cfg.dataDir = path.join(ROOT, 'data');
cfg.dbPath = path.join(cfg.dataDir, 'library.db');
cfg.imagesDir = path.join(cfg.dataDir, 'images');
cfg.subsCacheDir = path.join(cfg.dataDir, 'subs-cache');
cfg.thumbsDir = path.join(cfg.dataDir, 'thumbs');

for (const d of [cfg.dataDir, cfg.imagesDir, cfg.subsCacheDir, cfg.thumbsDir]) {
  fs.mkdirSync(d, { recursive: true });
}

export default cfg;
