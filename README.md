# Offline Netflix

A Netflix-style frontend for your local media library. Runs entirely on your
machine; a Windows Desktop shortcut boots the server and opens the browser.

## Daily use

Double-click **Offline Netflix** on your Desktop (a copy of `Offline Netflix.bat`
is also in this folder). The library loads at http://localhost:8420.

## One-time setup (order matters)

1. `npm run scan` — scans the library, parses season/episode ordering,
   matches stray `.srt` files, hides duplicates, probes durations, and can
   generate thumbnails (`npm run thumbs`).
2. `npm run rename:dry` — writes `data/rename-plan.json` showing exactly how
   every file/folder will be renamed. Review it, then `npm run rename:apply`
   when happy. Files are only touched once.
3. `npm run subs` — the subtitle pass. Per file, in order:
   1. extract subtitle streams already inside MKV/MP4 (slow on big 4K files —
      I/O bound, it must read the whole file once),
   2. reuse any `.srt`/`.ass` found next to the video,
   3. transcribe with **Whisper large-v3-turbo** on the RTX 3060 (needs
      `tools/setup-whisper.sh` run once; ~6GB VRAM).
   Resumable: re-running only processes files still missing subtitles.
4. TMDB metadata (posters, episode titles, proper display names): paste a free
   API key from https://www.themoviedb.org/settings/api into `config.json`
   (`tmdbApiKey`), then `npm run tmdb:sync` (internet needed once).

## Adding new media later

Drop it anywhere in `C:\Users\elias\Desktop\Media`, then run `npm run scan`
and `npm run subs` (or POST /api/scan). Each new file is processed exactly once.

## Layout

- `server.js` + `src/` — Express server, SQLite library DB (`data/library.db`),
  streaming with range requests, NVENC "compatibility mode" fallback for
  codecs the browser can't decode.
- `public/` — the UI.
- `tools/` — scan/rename/subs/whisper CLIs; Whisper lives in `tools/.venv`.

## Notes

- "Continue Watching" progress is per-episode in SQLite; nothing leaves your
  machine.
- If a file won't play in the browser (some HEVC/TS files), press **Compat**
  in the player — it re-encodes on the fly with NVENC.
