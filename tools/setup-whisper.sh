#!/usr/bin/env bash
# One-time setup for GPU (CUDA) transcription. Needs the NVIDIA driver on Windows.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating Python venv..."
  python3 -m venv .venv
fi

echo "Installing faster-whisper + CUDA libs (this downloads ~1GB, once)..."
.venv/bin/pip install --upgrade pip wheel
.venv/bin/pip install faster-whisper "av<19" "nvidia-cublas-cu12" "nvidia-cudnn-cu12"

# pip's nvidia-* wheels install the CUDA libs inside the venv, off the loader
# path — without this ctranslate2 can't find libcublas and falls back to CPU.
export LD_LIBRARY_PATH="$(printf '%s:' .venv/lib/python*/site-packages/nvidia/{cublas,cudnn}/lib 2>/dev/null | sed 's/:$//')${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

echo "Verifying CUDA availability..."
.venv/bin/python - <<'PY'
import ctranslate2
n = ctranslate2.get_cuda_device_count()
print(f"CUDA devices detected: {n}")
if n == 0:
    print("NOTE: no CUDA device visible — transcription will fall back to CPU (slow).")
PY

echo "Done. Subtitles will now transcribe on your RTX 3060."
