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
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

app_dir="$tmp_dir/next-artifact-app"
mkdir -p "$app_dir/app" "$app_dir/components"

cat > "$app_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "next build"
  },
  "dependencies": {
    "next": "16.2.9",
    "react": "19.2.7",
    "react-dom": "19.2.7"
  }
}
JSON

cat > "$app_dir/next.config.mjs" <<'JS'
export default {
  productionBrowserSourceMaps: true,
  turbopack: {}
};
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

if ! grep -q "sourcesContent" "$target_map"; then
  echo "expected Next source map to contain sourcesContent before LogBrew stripping" >&2
  exit 1
fi
if ! grep -q "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$target_map"; then
  echo "expected Next source map to contain the local source sentinel before stripping" >&2
  exit 1
fi

debug_plan_dry_run="$tmp_dir/next-debug-plan-dry-run.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$chunks_dir" \
  --strip-sources-content \
  > "$debug_plan_dry_run"

python3 - "$debug_plan_dry_run" "$target_js" "$target_map" "$chunks_dir" "$js_count" <<'PY'
import json
import re
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
target_js = Path(sys.argv[2])
target_map = Path(sys.argv[3])
chunks_dir = Path(sys.argv[4]).resolve()
js_count = int(sys.argv[5])
target_rel = target_js.resolve().relative_to(chunks_dir).as_posix()
target_map_rel = target_map.resolve().relative_to(chunks_dir).as_posix()

assert plan["validation"]["status"] == "ready"
assert plan["writeApplied"] is False
assert plan["stripSourcesContent"] is True
assert len(plan["artifacts"]) == js_count
target = next(artifact for artifact in plan["artifacts"] if artifact["path"] == target_rel)
assert target["sourceMapPath"] == target_map_rel
assert "sourceMap.sourcesContent" in target["changes"]
assert re.match(r"^[0-9a-f-]{36}$", target["debugId"])
PY

debug_plan_written="$tmp_dir/next-debug-plan-written.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$chunks_dir" \
  --strip-sources-content \
  --write \
  > "$debug_plan_written"

if grep -R -q "sourcesContent" "$chunks_dir" --include='*.map'; then
  echo "LogBrew Debug ID prep did not strip sourcesContent from Next source maps" >&2
  exit 1
fi
if grep -R -q "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$chunks_dir" --include='*.map'; then
  echo "raw Next source content leaked into stripped source maps" >&2
  exit 1
fi

ready_manifest="$tmp_dir/next-manifest.json"
python3 "$repo_root/scripts/create_js_release_artifact_manifest.py" \
  --build-dir "$chunks_dir" \
  --release "2026.06.18-next" \
  --environment "production" \
  --service "checkout-next-web" \
  --minified-path-prefix "app:///_next/static/chunks?cache=placeholder#fragment" \
  > "$ready_manifest"

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

symbolication_report="$tmp_dir/next-symbolication-report.json"
python3 "$repo_root/scripts/verify_js_release_artifact_symbolication.py" \
  --build-dir "$chunks_dir" \
  --manifest "$ready_manifest" \
  --stack-frame "$(cat "$generated_stack_frame")" \
  > "$symbolication_report"

python3 - "$debug_plan_written" "$ready_manifest" "$target_js" "$target_map" "$chunks_dir" "$symbolication_report" <<'PY'
import json
import sys
from pathlib import Path

debug_plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[3]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
target_rel = Path(sys.argv[3]).resolve().relative_to(Path(sys.argv[5]).resolve()).as_posix()
symbolication_report = json.loads(Path(sys.argv[6]).read_text(encoding="utf-8"))
serialized_manifest = json.dumps(manifest)
serialized_symbolication = json.dumps(symbolication_report)

debug_id = next(artifact["debugId"] for artifact in debug_plan["artifacts"] if artifact["path"] == target_rel)
artifact = next(candidate for candidate in manifest["artifacts"] if candidate["minifiedSource"]["path"] == target_rel)

assert debug_plan["validation"]["status"] == "ready"
assert debug_plan["writeApplied"] is True
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
assert "cache=placeholder" not in serialized_manifest
assert "fragment" not in serialized_manifest
assert "LOGBREW_NEXT_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_manifest
assert "next checkout exploded" not in serialized_manifest
assert "next checkout exploded" not in serialized_symbolication
PY

printf '%s\n' "real-user Next.js release artifact smoke ok"
