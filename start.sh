#!/usr/bin/env bash
# Starts the Offline Netflix server (idempotent) and waits until it's healthy.
cd "$(dirname "$0")"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Fallback if nvm isn't installed but a node binary exists somewhere obvious
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
fi

PORT=$(node -e "console.log(require('./config.json').port || 8420)" 2>/dev/null || echo 8420)

if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
  echo "server already running on $PORT"
  exit 0
fi

mkdir -p data
nohup node server.js > data/server.log 2>&1 &
echo "started server (pid $!), waiting for it to come up..."

for i in $(seq 1 30); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    echo "ready: http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done

echo "server did not become healthy — last log lines:"
tail -20 data/server.log
exit 1
