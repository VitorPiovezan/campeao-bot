#!/usr/bin/env bash
set -e
if [ -n "$COOKIES_B64" ]; then
  echo "$COOKIES_B64" | base64 -d > /data/cookies.txt
  echo "cookies.txt instalado ($(wc -l < /data/cookies.txt) linhas)"
fi
chrt --idle 0 nice -n 19 python3 /app/stt/server.py &
chrt --idle 0 nice -n 19 node /opt/bgutil/server/build/main.js &
if [ -n "$PARROT_BOT_TOKEN" ]; then
  node /app/src/parrot.mjs &
fi
exec node /app/src/index.mjs
