
# Offline Netflix

A Netflix-style frontend for your local media library. Runs entirely on your
machine; a Windows Desktop shortcut boots the server and opens the browser.

> The original spec: *"A continue-watching feature that remembers where I'm up
> to, subtitles (64 GB RAM / 12 GB VRAM — use powerful models), correct
> season/episode ordering, cleaned media names. Fast and nice."* — all four are
> in, and the subtitles piece now runs as a fully AI-generated pipeline.

## Features

- **Continue watching** — per-episode resume positions in SQLite, cards you can
  dismiss with the ✕, autoplay into the next episode.
- **AI-only subtitles** — external `.srt` files are never used (they were the
  source of wrong-episode / mis-synced tracks). Each file gets either its
  embedded English stream (frame-synced by construction) or a fresh Whisper
  transcription, labeled **English (AI)**. See "How subtitles work" below.
- **Correct ordering & clean names** — season/episode parsing, duplicate
  hiding, and a reviewed rename plan for the files on disk.
- **Codec-aware playback** — direct streaming when the browser can decode,
  automatic fallback to compatibility transcoding (NVENC when available, CPU
  x264 otherwise), with per-codec mode learning.
- **Player niceties** — always-visible ⏭ next-episode button (or press `N`),
  custom subtitle renderer, speed control, episode list.

## Clone to a new machine

The repo is self-contained and adapts to whatever machine it's on: the media
folder, Whisper venv, and ffmpeg are auto-detected at startup (env vars beat
`config.json`, which beats auto-detection).

**Option A — double-click (Windows + WSL):**

```bash
git clone https://github.com/<you>/offline-netflix.git
```

...then double-click **`Offline Netflix.bat`** in the cloned folder. The first
run bootstraps everything itself, no sudo and no manual installs: Node via
nvm, a static ffmpeg into `tools/bin/` (skipped if the system already has
ffmpeg), `npm install`, `config.json`, and the Whisper stack when the distro's
Python allows it (`WITH_WHISPER=0` to skip the ~1 GB download). It then starts
the server and opens the browser; later double-clicks skip straight to launch.
First run needs internet — everything after that is fully offline. A copy of
the .bat on the Desktop also works: it falls back to `~/offline-netflix` in
WSL when it isn't sitting in the repo itself.

**Option B — Docker (recommended for laptops):**

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

**Option C — native (bare metal, this WSL desktop):**

```bash
git clone https://github.com/<you>/offline-netflix.git
cd offline-netflix
./setup.sh                    # config bootstrap + npm install + Whisper venv
npm run scan && npm start
```

## Security note

This is a single-user, home-LAN app: the server has **no authentication**, and
the Settings page lets any client point the scanner at any folder and read the
TMDB key. It is meant to be accessed from `localhost` (or trusted devices on
your own network) only — do **not** port-forward it or expose it to untrusted
networks. If you need remote access, put it behind a VPN (e.g. Tailscale/WireGuard).

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
3. `npm run subs` — the subtitle pass (details below). Resumable: re-running
   only processes files still missing subtitles.
4. TMDB metadata (posters, episode titles, proper display names): paste a free
   API key from https://www.themoviedb.org/settings/api into `config.json`
   (`tmdbApiKey`), then `npm run tmdb:sync` (internet needed once).

## How subtitles work

Priority per file:

1. **Embedded English streams** — extracted from MKV/MP4 with ffmpeg and
   served as WebVTT. Streams titled "Forced" are skipped: they only translate
   foreign-language dialogue and are never full coverage.
2. **Whisper large-v3-turbo** (`tools/transcribe.py`, CUDA on the RTX 3060;
   ~6 GB VRAM). In practice ~15–27× realtime, so a full library pass takes
   hours, not days. Falls back to CPU automatically if no GPU is usable.

Design decisions baked into the pipeline:

- **External `.srt` files are never matched or reused.** They caused the
  original bug (subtitles synced to a different cut of the episode showing the
  wrong content). If you still want them for other players, fine — the app
  ignores them. Leftovers from the migration are renamed `*.external-bak` and
  can be deleted.
- **Transcribe, don't translate.** Whisper's translate pass produces degenerate
  timestamps even on English audio (30-second text blocks, 1-second junk cues).
  `transcribe.py` transcribes in the source language and only re-runs with
  `--task translate` when the detected language isn't English — foreign content
  still ends up with English subs.
- **Hallucination guards.** Segments that are one/two words repeated over and
  over (Whisper's classic music/silence hallucination) or low-confidence filler
  are dropped.
- **GPU libs.** pip's `nvidia-cublas-cu12` / `nvidia-cudnn-cu12` install inside
  the venv, off the loader path; `src/subtitles.js` points `LD_LIBRARY_PATH` at
  them per-spawn so ctranslate2 actually uses the GPU instead of silently
  falling back to CPU.
- **On demand.** Files without any track get a "Generate with AI (Whisper)"
  button in the subs menu; the player auto-selects the fresh track when done.

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

## Player shortcuts

`Space` play/pause · `N` next episode · `C` subtitle menu · `M` mute ·
`F` fullscreen · `Esc` back · arrow keys seek/volume.

## Layout

- `server.js` + `src/` — Express server, SQLite library DB (`data/library.db`),
  streaming with range requests, NVENC "compatibility mode" fallback for
  codecs the browser can't decode.
- `public/` — the UI.
- `tools/` — CLIs: `scan.mjs`, `rename.mjs`, `thumbs.mjs`, `tmdb-sync.mjs`,
  `subs-all.mjs` (the subtitle pass), `subs-ai-only.mjs` (one-off migration to
  AI-only subtitles), `prune-subs.mjs`; `first-run.sh` bootstraps a fresh clone
  (Node via nvm, static ffmpeg into `tools/bin/` — no sudo); Whisper lives in
  `tools/.venv`.

## Notes

- "Continue Watching" progress is per-episode in SQLite; nothing leaves your
  machine. Cards can be cleared with the ✕ in their top-right corner (this
  deletes the resume position for that episode).
- If a file won't play in the browser (some HEVC/TS files), the player falls
  back automatically to compatibility transcoding — it re-encodes on the fly
  with NVENC (auto-detected at startup; CPU x264 fallback). Files the browser
  can't hardware-decode (e.g. 4K 10-bit HEVC) are routed straight to
  transcode without trying the faster modes first.
- Whisper transcription is sequential and can take a while per file; the UI
  shows "AI queued / AI transcribing" badges, and finished tracks appear
  automatically without a reload.