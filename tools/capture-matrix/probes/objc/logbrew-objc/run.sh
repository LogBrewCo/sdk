#!/usr/bin/env bash
set -euo pipefail

clang -fobjc-arc -Wall -Wextra -Wpedantic -Werror -I"$LOGBREW_CAPTURE_WORK/include" probe.m \
  "$LOGBREW_CAPTURE_WORK"/objects/*.o -framework Foundation -o probe
python3 -I backend.py backend.port &
backend=$!
trap 'kill "$backend"' EXIT
while [[ ! -s backend.port ]]; do sleep 0.05; done
CAPTURE_BACKEND="http://127.0.0.1:$(cat backend.port)" ./probe
