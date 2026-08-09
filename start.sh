#!/usr/bin/env bash
set -e
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR/hf" "$DATA_DIR/cache" "$DATA_DIR/tracks"
if [ -n "$COOKIES_B64" ]; then
  echo "$COOKIES_B64" | base64 -d > "$DATA_DIR/cookies.txt"
  echo "cookies.txt instalado ($(wc -l < "$DATA_DIR/cookies.txt") linhas)"
fi
python3 /app/stt/server.py &
node /opt/bgutil/server/build/main.js &
exec node /app/src/index.mjs
