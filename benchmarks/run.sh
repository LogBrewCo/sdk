#!/usr/bin/env bash
# Runs every benchmark and prints one JSON result per benchmark.
# Usage: bash benchmarks/run.sh [--quick]
# --quick runs a few events only, to check that the benchmarks still work.
# The latency benchmark runs when LOGBREW_INGEST_KEY_FILE and LOGBREW_READ_KEY_FILE are set.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
bun install --frozen-lockfile
node size.mjs
node overhead.mjs "$@"
if [[ -n "${LOGBREW_INGEST_KEY_FILE:-}" && -n "${LOGBREW_READ_KEY_FILE:-}" ]]; then
  node latency.mjs "$@"
else
  echo "latency: skipped; set LOGBREW_INGEST_KEY_FILE and LOGBREW_READ_KEY_FILE to run it" >&2
fi
