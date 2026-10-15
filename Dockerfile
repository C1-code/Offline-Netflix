# Offline Netflix — self-contained image: Node app + ffmpeg + Whisper stack.
# The app auto-detects at runtime what the machine running it has (GPU or not,
# media folder location), so one image works everywhere.
#
# Build with or without the ~1GB Whisper/CUDA transcription stack:
#   docker build -t offline-netflix .                        # with Whisper
#   docker build --build-arg WITH_WHISPER=false -t offline-netflix .   # slim
FROM node:22-bookworm-slim

# ffmpeg: streaming, probing, thumbnails, subtitle extraction.
# python3 + venv: the Whisper transcription stack (falls back to CPU without a GPU).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps first for layer caching (better-sqlite3 ships prebuilt binaries
# for this Debian image, so no compiler toolchain is needed).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Whisper venv inside the image (~1GB incl. CUDA libs; only used by the
# subtitle pass). Skip with --build-arg WITH_WHISPER=false for a slim image.
ARG WITH_WHISPER=true
RUN if [ "$WITH_WHISPER" = "true" ]; then \
      python3 -m venv tools/.venv \
      && tools/.venv/bin/pip install --no-cache-dir --upgrade pip wheel \
      && tools/.venv/bin/pip install --no-cache-dir faster-whisper "av<19" "nvidia-cublas-cu12" "nvidia-cudnn-cu12"; \
    fi

# The image ships a `node` user with uid 1000 — the typical first user on
# Linux hosts — so bind-mounted ./data and ./config.json stay writable/readable
# from both sides.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
EXPOSE 8420
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]