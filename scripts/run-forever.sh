#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

mkdir -p logs

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot start" >> logs/supervisor.log
  node --enable-source-maps dist/index.js >> logs/bot.log 2>&1 || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] bot exited, restart in 3s" >> logs/supervisor.log
  sleep 3
done
