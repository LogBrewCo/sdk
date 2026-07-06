#!/usr/bin/env bash
set -Eeuo pipefail

curl_bin="${LOGBREW_CENTRAL_CURL:-curl}"
status_url="https://central.sonatype.com/api/v1/publisher/status?id=00000000-0000-0000-0000-000000000000"

missing=()
if [[ -z "${CENTRAL_PORTAL_USERNAME:-}" ]]; then
  missing+=(CENTRAL_PORTAL_USERNAME)
fi
if [[ -z "${CENTRAL_PORTAL_PASSWORD:-}" ]]; then
  missing+=(CENTRAL_PORTAL_PASSWORD)
fi
if [[ "${#missing[@]}" -gt 0 ]]; then
  printf 'Maven Central auth preflight blocked: missing %s\n' "${missing[*]}" >&2
  exit 2
fi

central_bearer="$(
  python3 - <<'PY'
import base64
import os

raw = f"{os.environ['CENTRAL_PORTAL_USERNAME']}:{os.environ['CENTRAL_PORTAL_PASSWORD']}".encode()
print(base64.b64encode(raw).decode())
PY
)"

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-central-auth.XXXXXX")"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

set +e
http_status="$(
  "$curl_bin" --silent --show-error \
    --output "$tmp_dir/body.json" \
    --write-out "%{http_code}" \
    --request POST \
    --header "Authorization: Bearer ${central_bearer}" \
    "$status_url" \
    2>"$tmp_dir/curl.stderr"
)"
curl_status=$?
set -e

if [[ "$curl_status" -ne 0 ]]; then
  cat "$tmp_dir/curl.stderr" >&2
  printf 'Maven Central auth preflight could not reach Central Portal status endpoint.\n' >&2
  exit "$curl_status"
fi

case "$http_status" in
  401 | 403)
    printf 'Maven Central authentication preflight failed with HTTP %s.\n' "$http_status" >&2
    printf '%s\n' \
      'Use generated Central Portal publishing values with co.logbrew namespace publish access,' \
      'not Central account login values.' >&2
    exit 2
    ;;
  [0-9][0-9][0-9])
    printf 'Maven Central auth preflight passed with HTTP %s.\n' "$http_status"
    ;;
  *)
    printf 'Maven Central auth preflight returned an unrecognized HTTP status.\n' >&2
    exit 1
    ;;
esac
