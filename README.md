# Offline Netflix

A Netflix-style frontend for your local media library. Runs entirely on your
machine; a Windows Desktop shortcut boots the server and opens the browser.

## Clone to a new machine

The repo is self-contained and adapts to whatever machine it's on: the media
folder, Whisper venv, and ffmpeg are auto-detected at startup (env vars beat
`config.json`, which beats auto-detection).

**Option A — Docker (recommended for laptops):**

```bash
git clone https://github.com/<you>/offline-netflix.git
cd offline-netflix
cp config.example.json config.json
cp .env.example .env          # set MEDIA_PATH to this machine's media folder
docker compose up -d          # add -f docker-compose.gpu.yml for NVIDIA GPUs
```

Then open http://localhost:8420. Everything else (DB, thumbnails, subtitles
cache) lives in `./data` and survives rebuilds. TMDB key: put it in `.env`
(`TMDB_API_KEY`) or the Settings page.

**Option B — native (bare metal, this WSL desktop):**

```bash
git clone https://github.com/<you>/offline-netflix.git
cd offline-netflix
./setup.sh                    # config bootstrap + npm install + Whisper venv
npm run scan && npm start
```

## Daily use

Double-click **Offline Netflix** on your Desktop (a copy of `Offline Netflix.bat`
is also in this folder). The library loads at http://localhost:8420.

## One-time setup (order matters)

1. `npm run scan` — scans the library, parses season/episode ordering,
   hides duplicates, probes durations, and can
   generate thumbnails (`npm run thumbs`).
2. `npm run rename:dry` — writes `data/rename-plan.json` showing exactly how
   every file/folder will be renamed. Review it, then `npm run rename:apply`
   when happy. Files are only touched once.
3. `npm run subs` — the subtitle pass. Per file, in order:
   1. extract subtitle streams already inside MKV/MP4 (slow on big 4K files —
      I/O bound, it must read the whole file once),
   2. transcribe with **Whisper large-v3-turbo** on the RTX 3060 (needs
      `tools/setup-whisper.sh` run once; ~6GB VRAM).
   External `.srt` files are never used — subtitles are always embedded
   streams or AI-generated, so they are frame-synced to the file being played.
   Resumable: re-running only processes files still missing subtitles.
4. TMDB metadata (posters, episode titles, proper display names): paste a free
   API key from https://www.themoviedb.org/settings/api into `config.json`
   (`tmdbApiKey`), then `npm run tmdb:sync` (internet needed once).

## Adding new media later

Drop it anywhere in your media folder — the server notices automatically
(auto-scan runs at startup, on folder changes, and every N minutes; the media
folder itself and the interval are configurable on the Settings page via the
⚙ button in the top bar). Each new file is processed exactly once.

New files are also finished automatically by the new-media pipeline:
1. probed with ffprobe (durations/codec info),
2. matched against TMDB for posters, episode titles and overviews (needs an
   API key in Settings or `TMDB_API_KEY`),
3. subtitles: embedded English streams are extracted, and
4. anything still without subtitles is queued for **Whisper transcription —
   only when an NVIDIA GPU is present** (`nvidia-smi` must work), so a laptop
   never silently spends CPU-days transcribing.

Everything degrades gracefully per machine: no TMDB key → step 2 is skipped;
no Whisper venv or no GPU → step 4 is skipped. Manual passes still work
(`npm run scan`, `npm run subs`) and are resumable.

## Layout

- `server.js` + `src/` — Express server, SQLite library DB (`data/library.db`),
  streaming with range requests, NVENC "compatibility mode" fallback for
  codecs the browser can't decode.
- `public/` — the UI.
- `tools/` — scan/rename/subs/whisper CLIs; Whisper lives in `tools/.venv`.

## Notes

- "Continue Watching" progress is per-episode in SQLite; nothing leaves your
  machine. Cards can be cleared with the ✕ in their top-right corner (this
  deletes the resume position for that episode).
- If a file won't play in the browser (some HEVC/TS files), the player falls
  back automatically to compatibility transcoding — it re-encodes on the fly
  with NVENC (auto-detected at startup; CPU x264 fallback). Files the browser
  can't hardware-decode (e.g. 4K 10-bit HEVC) are routed straight to
  transcode without trying the faster modes first.
