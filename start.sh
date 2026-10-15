#!/usr/bin/env bash
# Starts the Offline Netflix server. Every launch RESTARTS any previous
# instance of this project's server, so code/config changes always take effect.
cd "$(dirname "$0")"
ROOT="$(pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# Fallback if nvm isn't installed but a node binary exists somewhere obvious
if ! command -v node >/dev/null 2>&1; then
  export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$PATH"
fi

PORT=$(node -e "console.log(require('./config.json').port || 8420)" 2>/dev/null || echo 8420)

healthy() { curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; }

# Stop previous instances of THIS project's server. Match by working directory
# (not just command name or a pidfile) so other projects' node processes and
# recycled PIDs can never be touched.
mine=""
for p in $(pgrep -f "node server.js" 2>/dev/null); do
  argv0=$(tr '\0' '\n' < "/proc/$p/cmdline" 2>/dev/null | head -1)
  [ "$(basename "$argv0" 2>/dev/null)" = "node" ] || continue   # Node 24 sets comm to "MainThread", so check argv[0]
  [ "$(readlink -f "/proc/$p/cwd" 2>/dev/null)" = "$ROOT" ] || continue
  mine="$mine $p"
done
if [ -n "$mine" ]; then
  echo "stopping previous server (pids:$mine)..."
  kill $mine 2>/dev/null
  for i in $(seq 1 50); do healthy || break; sleep 0.2; done
  if healthy; then
    kill -9 $mine 2>/dev/null
    for i in $(seq 1 25); do healthy || break; sleep 0.2; done
  fi
  if healthy; then
    echo "could not stop the previous server on port $PORT — not starting a duplicate."
    exit 1
  fi
fi

mkdir -p data
nohup node server.js > data/server.log 2>&1 &
echo $! > data/server.pid
echo "started server (pid $!), waiting for it to come up..."

for i in $(seq 1 30); do
  if healthy; then
    echo "ready: http://localhost:$PORT"
    exit 0
  fi
  sleep 1
done

echo "server did not become healthy — last log lines:"
tail -20 data/server.log
exit 1
