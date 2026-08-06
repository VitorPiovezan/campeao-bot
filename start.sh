#!/usr/bin/env bash
set -e
python3 /app/stt/server.py &
node /opt/bgutil/server/build/main.js &
exec node /app/src/index.mjs
