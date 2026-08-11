#!/usr/bin/env bash
set -e
if [ -n "$COOKIES_B64" ]; then
  echo "$COOKIES_B64" | base64 -d > /data/cookies.txt
  echo "cookies.txt instalado ($(wc -l < /data/cookies.txt) linhas)"
fi
nice -n 15 python3 /app/stt/server.py &
nice -n 10 node /opt/bgutil/server/build/main.js &
exec node /app/src/index.mjs
