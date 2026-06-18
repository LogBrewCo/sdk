#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1
export npm_config_cache="$tmp_dir/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export CI=true
unset NO_COLOR FORCE_COLOR

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

app_dir="$tmp_dir/react-native-artifact-app"
mkdir -p "$app_dir"

react_native_version="$(npm view react-native version)"
react_version="$(npm view react version)"
react_native_cli_version="$(npm view @react-native-community/cli version)"
react_native_metro_config_version="$react_native_version"

cat > "$app_dir/package.json" <<JSON
{
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "react": "$react_version",
    "react-native": "$react_native_version"
  },
  "devDependencies": {
    "@react-native-community/cli": "$react_native_cli_version",
    "@react-native/metro-config": "$react_native_metro_config_version"
  }
}
JSON

cat > "$app_dir/index.js" <<'JS'
import { AppRegistry } from "react-native";

// LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD
const cart = [7, 11, 29];

function CheckoutProbe() {
  const total = cart.reduce((sum, item) => sum + item, 0);
  global.__logbrewReactNativeProbe = function checkoutFailureSignal() {
    throw new Error(`react native checkout exploded ${total}`);
  };
  return null;
}

AppRegistry.registerComponent("LogBrewSmoke", () => CheckoutProbe);
JS

cat > "$app_dir/metro.config.js" <<'JS'
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

module.exports = mergeConfig(getDefaultConfig(__dirname), {});
JS

(
  cd "$app_dir"
  npm install --silent
  npm ls react react-native @react-native-community/cli @react-native/metro-config >/dev/null
  mkdir -p dist
  node node_modules/@react-native-community/cli/build/bin.js bundle \
    --platform android \
    --dev false \
    --entry-file index.js \
    --bundle-output dist/index.android.bundle \
    --sourcemap-output dist/index.android.bundle.map \
    --assets-dest dist/assets
)

dist_dir="$app_dir/dist"
bundle_file="$dist_dir/index.android.bundle"
map_file="$dist_dir/index.android.bundle.map"
app_dir_real="$(cd "$app_dir" && pwd -P)"

if [[ ! -s "$bundle_file" || ! -s "$map_file" ]]; then
  echo "expected React Native bundle and source map output" >&2
  exit 1
fi
if ! grep -q "react native checkout exploded" "$bundle_file"; then
  echo "expected Metro bundle to contain the checkout error marker" >&2
  exit 1
fi
if ! grep -q "sourcesContent" "$map_file"; then
  echo "expected Metro source map to contain sourcesContent before LogBrew stripping" >&2
  exit 1
fi
if ! grep -q "LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$map_file"; then
  echo "expected Metro source map to contain local source content before stripping" >&2
  exit 1
fi
if ! grep -q "$app_dir_real" "$map_file"; then
  echo "expected Metro source map to contain absolute app paths before LogBrew prefix stripping" >&2
  exit 1
fi

debug_plan_dry_run="$tmp_dir/react-native-debug-plan-dry-run.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  --strip-sources-content \
  --strip-source-prefix "$app_dir_real" \
  > "$debug_plan_dry_run"

python3 - "$debug_plan_dry_run" "$app_dir_real" <<'PY'
import json
import re
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
app_dir = sys.argv[2]
artifact = plan["artifacts"][0]

assert plan["validation"]["status"] == "ready"
assert plan["writeApplied"] is False
assert plan["stripSourcesContent"] is True
assert plan["stripSourcePrefixes"] == [app_dir]
assert len(plan["artifacts"]) == 1
assert artifact["path"] == "index.android.bundle"
assert artifact["sourceMapPath"] == "index.android.bundle.map"
assert artifact["changes"] == [
    "minifiedSource.debugId",
    "sourceMap.debug_id",
    "sourceMap.sourcesContent",
    "sourceMap.sources",
]
assert re.match(r"^[0-9a-f-]{36}$", artifact["debugId"])
PY

debug_plan_written="$tmp_dir/react-native-debug-plan-written.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  --strip-sources-content \
  --strip-source-prefix "$app_dir_real" \
  --write \
  > "$debug_plan_written"

if grep -q "sourcesContent" "$map_file"; then
  echo "LogBrew Debug ID prep did not strip sourcesContent from the React Native source map" >&2
  exit 1
fi
if grep -q "LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$map_file"; then
  echo "raw React Native source content leaked into the stripped source map" >&2
  exit 1
fi
if grep -q "$app_dir_real" "$map_file"; then
  echo "absolute React Native app paths leaked into the stripped source map" >&2
  exit 1
fi

ready_manifest="$tmp_dir/react-native-manifest.json"
python3 "$repo_root/scripts/create_js_release_artifact_manifest.py" \
  --build-dir "$dist_dir" \
  --release "2026.06.18-react-native" \
  --environment "production" \
  --service "checkout-react-native" \
  --minified-path-prefix "app:///react-native?cache=placeholder#fragment" \
  > "$ready_manifest"

generated_stack_frame="$tmp_dir/react-native-stack-frame.txt"
python3 - "$ready_manifest" "$bundle_file" > "$generated_stack_frame" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
bundle_file = Path(sys.argv[2])
artifact = manifest["artifacts"][0]
source = bundle_file.read_text(encoding="utf-8")
needle = "react native checkout exploded"
index = source.find(needle)
if index < 0:
    raise SystemExit("expected minified React Native bundle to contain the checkout error marker")
before = source[:index]
line = before.count("\n") + 1
last_newline = before.rfind("\n")
column = index - last_newline
print(f"at checkoutFailureSignal ({artifact['minifiedSource']['minifiedUrl']}:{line}:{column})")
PY

symbolication_report="$tmp_dir/react-native-symbolication-report.json"
python3 "$repo_root/scripts/verify_js_release_artifact_symbolication.py" \
  --build-dir "$dist_dir" \
  --manifest "$ready_manifest" \
  --stack-frame "$(cat "$generated_stack_frame")" \
  > "$symbolication_report"

python3 - "$debug_plan_written" "$ready_manifest" "$bundle_file" "$map_file" "$app_dir_real" "$symbolication_report" <<'PY'
import json
import sys
from pathlib import Path

debug_plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[3]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
app_dir = sys.argv[5]
symbolication_report = json.loads(Path(sys.argv[6]).read_text(encoding="utf-8"))
serialized_manifest = json.dumps(manifest)
serialized_symbolication = json.dumps(symbolication_report)

debug_id = debug_plan["artifacts"][0]["debugId"]
artifact = manifest["artifacts"][0]

assert debug_plan["validation"]["status"] == "ready"
assert debug_plan["writeApplied"] is True
assert "debugId=" in bundle_source
assert source_map["debug_id"] == debug_id
assert "sourcesContent" not in source_map
assert source_map["sources"][0] == "__prelude__"
assert "index.js" in source_map["sources"]
assert not any(isinstance(source, str) and source.startswith("/") for source in source_map["sources"])
assert app_dir not in json.dumps(source_map)
assert manifest["validation"]["status"] == "ready"
assert artifact["debugId"] == debug_id
assert artifact["sourceMap"]["hasSourcesContent"] is False
assert artifact["minifiedSource"]["path"] == "index.android.bundle"
assert artifact["sourceMap"]["path"] == "index.android.bundle.map"
assert artifact["minifiedSource"]["minifiedUrl"] == "app:///react-native/index.android.bundle"
assert symbolication_report["status"] == "resolved"
assert symbolication_report["debugId"] == debug_id
assert symbolication_report["generated"]["path"] == "index.android.bundle"
assert symbolication_report["original"]["source"] == "index.js"
assert "cache=placeholder" not in serialized_manifest
assert "fragment" not in serialized_manifest
assert "LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_manifest
assert "react native checkout exploded" not in serialized_manifest
assert "react native checkout exploded" not in serialized_symbolication
assert app_dir not in serialized_manifest
assert app_dir not in serialized_symbolication
PY

printf 'real-user React Native release artifact smoke ok with react-native@%s react@%s cli@%s\n' \
  "$react_native_version" \
  "$react_version" \
  "$react_native_cli_version"
