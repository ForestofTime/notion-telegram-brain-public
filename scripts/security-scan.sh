#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

scan_target() {
  grep -R -nE \
    --exclude-dir=.git \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude='*.png' --exclude='*.jpg' --exclude='*.jpeg' --exclude='*.gif' \
    --exclude='security-scan.sh' \
    "$1" . || true
}

hit=0

# Real token shapes
for p in 'ntn_[A-Za-z0-9_-]{20,}' '[0-9]{9,10}:[A-Za-z0-9_-]{30,}'; do
  out="$(scan_target "$p")"
  if [[ -n "$out" ]]; then
    echo "[HIT] token pattern: $p"
    echo "$out"
    hit=1
  fi
done

# Generic credential-like patterns
for p in 'root@[0-9]{1,3}(\\.[0-9]{1,3}){3}' '(?i)(password|passwd|pwd)[[:space:]]*[:=][[:space:]]*[^[:space:]]{4,}'; do
  out="$(scan_target "$p")"
  if [[ -n "$out" ]]; then
    echo "[HIT] credential pattern: $p"
    echo "$out"
    hit=1
  fi
done

if [[ "$hit" -eq 1 ]]; then
  echo "security scan failed"
  exit 1
fi

echo "security scan passed"
