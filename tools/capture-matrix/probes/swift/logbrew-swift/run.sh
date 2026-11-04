#!/usr/bin/env bash
set -euo pipefail

python3 -I backend.py backend.port &
backend=$!
trap 'kill "$backend"' EXIT
while [[ ! -s backend.port ]]; do sleep 0.05; done
export CAPTURE_BACKEND="http://127.0.0.1:$(cat backend.port)"

probe="$LOGBREW_CAPTURE_WORK/app/.build/debug/CaptureProbe"
rm -rf "$LOGBREW_CAPTURE_WORK/swift-crashes"
if "$probe" crash; then
  echo "the crash run exited without crashing" >&2
  exit 1
fi
"$probe"
