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

app_dir="$tmp_dir/vite-app"
mkdir -p "$app_dir/src"

cat > "$app_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build"
  },
  "devDependencies": {
    "@jridgewell/trace-mapping": "0.3.31",
    "esbuild": "0.28.1",
    "vite": "8.0.16"
  }
}
JSON

cat > "$app_dir/index.html" <<'HTML'
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>LogBrew Vite release artifact smoke</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>
HTML

cat > "$app_dir/src/main.js" <<'JS'
// LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD
const checkoutItems = [12, 30, 48];

function checkoutFailureSignal() {
  const total = checkoutItems.reduce((sum, item) => sum + item, 0);
  throw new Error(`checkout exploded ${total}`);
}

window.__logbrewViteProbe = { checkoutFailureSignal };
document.querySelector("#app").textContent = `items:${checkoutItems.length}`;
JS

cat > "$app_dir/vite.config.js" <<'JS'
export default {
  build: {
    minify: "esbuild",
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js"
      }
    }
  }
};
JS

(
  cd "$app_dir"
  npm install --silent
  npm run --silent build
)

dist_dir="$app_dir/dist"
js_files=()
while IFS= read -r js_path; do
  js_files+=("$js_path")
done < <(find "$dist_dir" -type f -name "*.js" ! -name "*.map" | sort)
if [[ "${#js_files[@]}" -ne 1 ]]; then
  printf 'expected one Vite JavaScript artifact, found %s\n' "${#js_files[@]}" >&2
  exit 1
fi

js_file="${js_files[0]}"
map_file="$js_file.map"
if [[ ! -s "$map_file" ]]; then
  printf 'expected Vite source map next to %s\n' "$js_file" >&2
  exit 1
fi

if ! grep -q "sourcesContent" "$map_file"; then
  echo "expected Vite source map to contain sourcesContent before LogBrew stripping" >&2
  exit 1
fi

debug_plan_dry_run="$tmp_dir/vite-debug-plan-dry-run.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  --strip-sources-content \
  > "$debug_plan_dry_run"

python3 - "$debug_plan_dry_run" <<'PY'
import json
import re
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
artifact = plan["artifacts"][0]

assert plan["validation"]["status"] == "ready"
assert plan["writeApplied"] is False
assert plan["stripSourcesContent"] is True
assert len(plan["artifacts"]) == 1
assert artifact["path"].startswith("assets/")
assert artifact["sourceMapPath"] == f"{artifact['path']}.map"
assert "sourceMappingURL comment missing; checked sibling .map fallback" in artifact["validation"]["warnings"]
assert artifact["changes"] == ["minifiedSource.debugId", "sourceMap.debug_id", "sourceMap.sourcesContent"]
assert re.match(r"^[0-9a-f-]{36}$", artifact["debugId"])
PY

debug_plan_written="$tmp_dir/vite-debug-plan-written.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  --strip-sources-content \
  --write \
  > "$debug_plan_written"

if grep -q "sourcesContent" "$map_file"; then
  echo "LogBrew Debug ID prep did not strip sourcesContent from the Vite source map" >&2
  exit 1
fi
if grep -q "LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$map_file"; then
  echo "raw Vite source content leaked into the stripped source map" >&2
  exit 1
fi

ready_manifest="$tmp_dir/vite-manifest.json"
python3 "$repo_root/scripts/create_js_release_artifact_manifest.py" \
  --build-dir "$dist_dir" \
  --release "2026.06.18-vite" \
  --environment "production" \
  --service "checkout-web" \
  --minified-path-prefix "https://cdn.example/static?cache=placeholder#fragment" \
  > "$ready_manifest"

(
  cd "$app_dir"
  node --input-type=module - "$js_file" "$map_file" <<'JS'
import { readFileSync } from "node:fs";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";

const [, , jsPath, mapPath] = process.argv;
const jsSource = readFileSync(jsPath, "utf8");
const needle = "checkout exploded";
const index = jsSource.indexOf(needle);
if (index === -1) {
  throw new Error("expected minified Vite bundle to contain the checkout error marker");
}
const before = jsSource.slice(0, index);
const line = before.split("\n").length;
const lastNewline = before.lastIndexOf("\n");
const column = index - (lastNewline + 1);
const traceMap = new TraceMap(JSON.parse(readFileSync(mapPath, "utf8")));
const original = originalPositionFor(traceMap, { line, column });
if (!original.source || !original.source.endsWith("src/main.js")) {
  throw new Error(`expected source map to resolve to src/main.js, got ${JSON.stringify(original)}`);
}
JS
)

python3 - "$debug_plan_written" "$ready_manifest" "$js_file" "$map_file" <<'PY'
import json
import sys
from pathlib import Path

debug_plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[3]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
serialized_manifest = json.dumps(manifest)

debug_id = debug_plan["artifacts"][0]["debugId"]
artifact = manifest["artifacts"][0]

assert debug_plan["validation"]["status"] == "ready"
assert debug_plan["writeApplied"] is True
assert "debugId=" in bundle_source
assert source_map["debug_id"] == debug_id
assert "sourcesContent" not in source_map
assert manifest["validation"]["status"] == "ready"
assert artifact["debugId"] == debug_id
assert artifact["sourceMap"]["hasSourcesContent"] is False
assert artifact["minifiedSource"]["minifiedUrl"].startswith("https://cdn.example/static/assets/")
assert "cache=placeholder" not in serialized_manifest
assert "fragment" not in serialized_manifest
assert "LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_manifest
assert "checkout exploded" not in serialized_manifest
PY

printf '%s\n' "real-user Vite release artifact smoke ok"
