#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1
export npm_config_cache="$tmp_dir/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false

remove_tmp_dir() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

app_dir="$tmp_dir/next-artifact-app"
mkdir -p "$app_dir/app" "$app_dir/components"

sdk_pack_json="$tmp_dir/sdk-pack.json"
next_pack_json="$tmp_dir/next-pack.json"
(
  cd "$repo_root/js/logbrew-js"
  npm pack --silent --json > "$sdk_pack_json"
)
(
  cd "$repo_root/js/logbrew-next"
  npm pack --silent --json > "$next_pack_json"
)
sdk_tgz="$(
  python3 - "$sdk_pack_json" <<'PY'
import json
import sys
from pathlib import Path

pack = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))[0]
files = {entry["path"] for entry in pack["files"]}
for expected in {
    "release-artifacts.js",
    "release-artifacts-symbolication.js",
    "vite-release-artifacts.cjs",
    "vite-release-artifacts.js",
}:
    assert expected in files, f"missing packed SDK release-artifact file: {expected}"
print(pack["filename"])
PY
)"
next_tgz="$(
  python3 - "$next_pack_json" <<'PY'
import json
import sys
from pathlib import Path

pack = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))[0]
files = {entry["path"] for entry in pack["files"]}
for expected in {
    "release-artifacts.cjs",
    "release-artifacts.js",
    "release-artifacts.d.ts",
    "release-artifacts.d.cts",
}:
    assert expected in files, f"missing packed Next release-artifact helper: {expected}"
print(pack["filename"])
PY
)"
sdk_tgz="$repo_root/js/logbrew-js/$sdk_tgz"
next_tgz="$repo_root/js/logbrew-next/$next_tgz"
cp "$sdk_tgz" "$tmp_dir/logbrew-sdk.tgz"
cp "$next_tgz" "$tmp_dir/logbrew-next.tgz"

cat > "$app_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build"
  },
  "dependencies": {
    "@logbrew/sdk": "file:../logbrew-sdk.tgz",
    "@logbrew/next": "file:../logbrew-next.tgz",
    "next": "16.2.9",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  }
}
JSON

cat > "$app_dir/next.config.mjs" <<'JS'
import { withLogBrewNextReleaseArtifacts } from "@logbrew/next/release-artifacts";

export default withLogBrewNextReleaseArtifacts(
  {
    turbopack: {}
  },
  {
    release: "2026.06.18-next",
    environment: "production",
    service: "checkout-next-web",
    minifiedPathPrefix: "app:///_next/static/chunks?logbrew_next_cache_placeholder=1#logbrew_next_hash_placeholder",
    manifestPath: ".next/logbrew-release-artifacts.json"
  }
);
JS

cat > "$app_dir/app/layout.jsx" <<'JS'
export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
JS

cat > "$app_dir/app/page.jsx" <<'JS'
import CheckoutProbe from "../components/CheckoutProbe.jsx";

export default function Page() {
  return <CheckoutProbe />;
}
JS

cat > "$app_dir/components/CheckoutProbe.jsx" <<'JS'
"use client";

// LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD
const cart = [19, 23, 42];

export default function CheckoutProbe() {
  const total = cart.reduce((sum, item) => sum + item, 0);
  if (typeof window !== "undefined") {
    window.__logbrewNextProbe = function checkoutFailureSignal() {
      throw new Error(`next checkout exploded ${total}`);
    };
  }
  return <main>checkout {total}</main>;
}
JS

(
  cd "$app_dir"
  npm install --silent
  node --input-type=module - <<'JS'
import { withLogBrewNextReleaseArtifacts } from "@logbrew/next/release-artifacts";

if (typeof withLogBrewNextReleaseArtifacts !== "function") {
  throw new Error("expected Next release-artifact helper export");
}
JS
  node - <<'JS'
const { withLogBrewNextReleaseArtifacts, default: defaultExport } = require("@logbrew/next/release-artifacts");

if (typeof withLogBrewNextReleaseArtifacts !== "function" || defaultExport !== withLogBrewNextReleaseArtifacts) {
  throw new Error("expected CommonJS Next release-artifact helper export");
}
JS
  NEXT_TELEMETRY_DISABLED=1 npm run --silent build >/dev/null
)

chunks_dir="$app_dir/.next/static/chunks"
if [[ ! -d "$chunks_dir" ]]; then
  echo "expected Next build to emit .next/static/chunks" >&2
  exit 1
fi

js_count="$(find "$chunks_dir" -type f -name "*.js" ! -name "*.map" | wc -l | tr -d ' ')"
map_count="$(find "$chunks_dir" -type f -name "*.map" | wc -l | tr -d ' ')"
if [[ "$js_count" -lt 1 || "$map_count" -lt 1 ]]; then
  printf 'expected Next chunks and source maps, got js=%s maps=%s\n' "$js_count" "$map_count" >&2
  exit 1
fi

target_js="$(grep -R -l "next checkout exploded" "$chunks_dir" --include='*.js' | head -n 1 || true)"
if [[ -z "$target_js" ]]; then
  echo "expected Next client chunk to contain the checkout error marker" >&2
  exit 1
fi

target_map="$(python3 - "$repo_root" "$chunks_dir" "$target_js" <<'PY'
import sys
from pathlib import Path

scripts_dir = Path(sys.argv[1]) / "scripts"
sys.path.insert(0, str(scripts_dir))
from create_js_release_artifact_manifest import find_source_mapping_url, resolve_source_map_path

chunks_dir = Path(sys.argv[2])
target_js = Path(sys.argv[3])
source_mapping_url = find_source_mapping_url(target_js.read_text(encoding="utf-8", errors="replace"))
source_map_path, _warnings, errors = resolve_source_map_path(target_js, chunks_dir, source_mapping_url)
if errors or source_map_path is None or not source_map_path.exists():
    raise SystemExit(f"could not resolve target source map: {errors}")
print(source_map_path.resolve())
PY
)"

if grep -R -q "sourcesContent" "$chunks_dir" --include='*.map'; then
  echo "LogBrew Next helper did not strip sourcesContent from Next source maps" >&2
  exit 1
fi
if grep -R -q "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$chunks_dir" --include='*.map'; then
  echo "raw Next source content leaked into stripped source maps" >&2
  exit 1
fi

ready_manifest="$app_dir/.next/logbrew-release-artifacts.json"
if [[ ! -f "$ready_manifest" ]]; then
  echo "expected LogBrew Next helper to write .next/logbrew-release-artifacts.json" >&2
  exit 1
fi

generated_stack_frame="$tmp_dir/next-stack-frame.txt"
python3 - "$ready_manifest" "$target_js" "$chunks_dir" > "$generated_stack_frame" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
target_js = Path(sys.argv[2]).resolve()
chunks_dir = Path(sys.argv[3]).resolve()
target_rel = target_js.relative_to(chunks_dir).as_posix()
artifact = next(candidate for candidate in manifest["artifacts"] if candidate["minifiedSource"]["path"] == target_rel)
source = target_js.read_text(encoding="utf-8")
needle = "next checkout exploded"
index = source.find(needle)
if index < 0:
    raise SystemExit("expected minified Next chunk to contain the checkout error marker")
before = source[:index]
line = before.count("\n") + 1
last_newline = before.rfind("\n")
column = index - last_newline
print(f"at checkoutFailureSignal ({artifact['minifiedSource']['minifiedUrl']}:{line}:{column})")
PY

release_artifacts_cli="$app_dir/node_modules/.bin/logbrew-release-artifacts"
symbolication_report="$tmp_dir/next-symbolication-report.json"
(
  cd "$app_dir"
  "$release_artifacts_cli" \
    symbolicate-js \
    --build-dir "$chunks_dir" \
    --manifest "$ready_manifest" \
    --stack-frame "$(cat "$generated_stack_frame")" \
    > "$symbolication_report"
)

python3 - "$ready_manifest" "$target_js" "$target_map" "$chunks_dir" "$symbolication_report" "$js_count" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[2]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
target_rel = Path(sys.argv[2]).resolve().relative_to(Path(sys.argv[4]).resolve()).as_posix()
symbolication_report = json.loads(Path(sys.argv[5]).read_text(encoding="utf-8"))
js_count = int(sys.argv[6])
serialized_manifest = json.dumps(manifest)
serialized_symbolication = json.dumps(symbolication_report)

artifact = next(candidate for candidate in manifest["artifacts"] if candidate["minifiedSource"]["path"] == target_rel)
debug_id = artifact["debugId"]

assert len(manifest["artifacts"]) == js_count
assert "debugId=" in bundle_source
assert source_map["debug_id"] == debug_id
assert "sourcesContent" not in source_map
assert manifest["validation"]["status"] == "ready"
assert artifact["debugId"] == debug_id
assert artifact["sourceMap"]["hasSourcesContent"] is False
assert artifact["minifiedSource"]["minifiedUrl"].startswith("app:///_next/static/chunks/")
assert symbolication_report["status"] == "resolved"
assert symbolication_report["debugId"] == debug_id
assert symbolication_report["generated"]["path"] == target_rel
assert symbolication_report["original"]["source"].endswith("components/CheckoutProbe.jsx")
assert "logbrew_next_cache_placeholder" not in serialized_manifest
assert "logbrew_next_hash_placeholder" not in serialized_manifest
assert "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_manifest
assert "next checkout exploded" not in serialized_manifest
assert "next checkout exploded" not in serialized_symbolication
PY

port_file="$tmp_dir/fake-intake-port"
state_file="$tmp_dir/fake-intake-state.json"
expected_bearer="fake-next-release-artifact-auth-value"

python3 "$repo_root/scripts/js_release_artifact_fake_intake.py" \
  --port-file "$port_file" \
  --state-file "$state_file" \
  --expected-bearer "$expected_bearer" \
  --source-sentinel "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" \
  --query-placeholder "logbrew_next_cache_placeholder" \
  --hash-fragment "logbrew_next_hash_placeholder" &
server_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi
  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "fake Next.js release-artifact intake did not start" >&2
  exit 1
fi

endpoint_base="http://127.0.0.1:$(cat "$port_file")"
export LOGBREW_RELEASE_ARTIFACT_TOKEN="$expected_bearer"
upload_report="$tmp_dir/next-upload-report.json"
"$release_artifacts_cli" upload-js \
  --build-dir "$chunks_dir" \
  --manifest "$ready_manifest" \
  --endpoint "$endpoint_base/retry-success?ignored=query#ignored" \
  --retry-delay 0 \
  --max-retries 2 \
  > "$upload_report"

python3 - "$upload_report" "$state_file" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

upload_report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
state = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[3]

assert upload_report["status"] == "uploaded"
assert upload_report["retryCount"] == 1
assert [attempt["httpStatus"] for attempt in upload_report["attempts"]] == [503, 202]
assert upload_report["endpoint"].endswith("/retry-success")
assert "ignored=query" not in json.dumps(upload_report)

events = state["events"]
assert [event["path"] for event in events].count("/retry-success") == 2
assert all(event["containsManifest"] for event in events)
assert all(event["containsSourceMapPart"] for event in events)
assert all(event["containsMinifiedPart"] for event in events)
assert not any(event["containsSourceSentinel"] for event in events)
assert not any(event["containsAuthValue"] for event in events)
assert not any(event["containsQueryPlaceholder"] for event in events)
assert not any(event["containsHashFragment"] for event in events)
assert not any(event["containsTempPath"] for event in events)
assert tmp_dir not in json.dumps(upload_report)
PY

printf '%s\n' "real-user Next.js release artifact smoke ok"
