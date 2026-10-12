#!/usr/bin/env bash
# One-time project setup: node deps + GPU transcription stack.
set -euo pipefail
cd "$(dirname "$0")"

echo "== Installing node dependencies =="
npm install

echo "== Setting up Whisper (GPU subtitles) =="
bash tools/setup-whisper.sh

echo
echo "Setup complete. Now:"
echo "  1. npm run scan            (build the library)"
echo "  2. npm run rename:dry      (review, then npm run rename:apply)"
echo "  3. npm run subs            (batch subtitles: embedded first, Whisper for the rest)"
echo "  4. npm start               (http://localhost:8420)"
