#!/usr/bin/env bash
set -e
python3 /app/stt/server.py &
exec node /app/src/index.mjs
