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

echo "Installing diarization stack for speaker-named subtitles (~2.5GB incl. torch, once)..."
.venv/bin/pip install pyannote.audio soundfile torchaudio

# Speaker naming also needs a local Ollama server (https://ollama.com) with any
# instruct model, e.g.:  ollama pull qwen3:4b   (subsNamingModel in config.json).
# Diarization itself needs a free Hugging Face token, ONE TIME per machine:
#   1. create an account at https://huggingface.co
#   2. accept the terms at https://huggingface.co/pyannote/speaker-diarization-3.1
#      (and https://huggingface.co/pyannote/segmentation-3.0)
#   3. put the token in config.json as "whisperHfToken" (or env HF_TOKEN)
# Without the token/Ollama, subtitles are still generated — just without
# speaker names.

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
