#!/usr/bin/env bash
# One-time project setup: config bootstrap + node deps + GPU transcription stack.
set -euo pipefail
cd "$(dirname "$0")"

echo "== Bootstrapping config.json =="
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "Created config.json from config.example.json."
  echo "The media folder is auto-detected; set 'mediaPath' manually or via"
  echo "the Settings page (⚙) in the UI if detection picks the wrong one."
else
  echo "config.json already exists — leaving it alone."
fi

echo "== Installing node dependencies =="
npm install

echo "== Setting up Whisper (GPU subtitles) =="
if [ "${WITH_WHISPER:-1}" = "1" ]; then
  bash tools/setup-whisper.sh
else
  echo "WITH_WHISPER=0 — skipping (AI subtitles disabled; embedded/external subs still work)."
fi

echo
echo "Setup complete. Now:"
echo "  1. npm run scan            (build the library)"
echo "  2. npm run rename:dry      (review, then npm run rename:apply)"
echo "  3. npm run subs            (batch subtitles: embedded first, Whisper for the rest)"
echo "  4. npm start               (http://localhost:8420)"
echo
echo "Prefer containers? See 'Docker' in the README instead: docker compose up -d"
