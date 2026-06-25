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

app_dir="$tmp_dir/vite-app"
mkdir -p "$app_dir/src"

sdk_pack_json="$tmp_dir/sdk-pack.json"
(
  cd "$repo_root/js/logbrew-js"
  npm pack --silent --json > "$sdk_pack_json"
)
sdk_tgz="$(
  python3 - "$sdk_pack_json" <<'PY'
import json
import sys
from pathlib import Path

pack = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))[0]
files = {entry["path"] for entry in pack["files"]}
for expected in {
    "vite-release-artifacts.cjs",
    "vite-release-artifacts.js",
    "vite-release-artifacts.d.ts",
    "vite-release-artifacts.d.cts",
}:
    assert expected in files, f"missing packed Vite release-artifact helper: {expected}"
print(pack["filename"])
PY
)"
sdk_tgz="$repo_root/js/logbrew-js/$sdk_tgz"

cat > "$app_dir/package.json" <<'JSON'
{
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build"
  },
  "devDependencies": {
    "@logbrew/sdk": "file:../logbrew-sdk.tgz",
    "esbuild": "0.28.1",
    "vite": "8.0.16"
  }
}
JSON

cp "$sdk_tgz" "$tmp_dir/logbrew-sdk.tgz"

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
import { createLogBrewViteReleaseArtifactsPlugin } from "@logbrew/sdk/vite-release-artifacts";

export default {
  build: {
    minify: "esbuild",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js"
      }
    }
  },
  plugins: [
    createLogBrewViteReleaseArtifactsPlugin({
      release: "2026.06.18-vite",
      environment: "production",
      service: "checkout-web",
      minifiedPathPrefix: "https://cdn.example/static?cache=placeholder#fragment",
      manifestPath: "dist/logbrew-release-artifacts.json"
    })
  ]
};
JS

(
  cd "$app_dir"
  npm install --silent
  node --input-type=module - <<'JS'
import { createLogBrewViteReleaseArtifactsPlugin } from "@logbrew/sdk/vite-release-artifacts";

if (typeof createLogBrewViteReleaseArtifactsPlugin !== "function") {
  throw new Error("expected Vite release-artifact plugin export");
}
JS
  node - <<'JS'
const { createLogBrewViteReleaseArtifactsPlugin, default: defaultExport } = require("@logbrew/sdk/vite-release-artifacts");

if (typeof createLogBrewViteReleaseArtifactsPlugin !== "function" || defaultExport !== createLogBrewViteReleaseArtifactsPlugin) {
  throw new Error("expected CommonJS Vite release-artifact plugin export");
}
JS
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

if grep -q "sourcesContent" "$map_file"; then
  echo "LogBrew Vite plugin did not strip sourcesContent from the source map" >&2
  exit 1
fi
if grep -q "LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" "$map_file"; then
  echo "raw Vite source content leaked into the stripped source map" >&2
  exit 1
fi

ready_manifest="$dist_dir/logbrew-release-artifacts.json"
if [[ ! -s "$ready_manifest" ]]; then
  echo "expected LogBrew Vite plugin to write a release-artifact manifest" >&2
  exit 1
fi

actual_stack_frame="$tmp_dir/vite-stack-frame.txt"
(
  cd "$app_dir"
  node --input-type=module - "$js_file" > "$actual_stack_frame" <<'JS'
import { readFileSync } from "node:fs";
import vm from "node:vm";

const [, , jsPath] = process.argv;
const jsSource = readFileSync(jsPath, "utf8");
const sandbox = {
  document: {
    createElement() {
      return {
        relList: {
          supports() {
            return true;
          },
        },
      };
    },
    querySelector() {
      return {};
    },
  },
  window: {},
};
vm.runInNewContext(jsSource, sandbox, { filename: jsPath });
try {
  sandbox.window.__logbrewViteProbe.checkoutFailureSignal();
} catch (error) {
  const frame = String(error.stack || "")
    .split("\n")
    .find((line) => line.includes(jsPath));
  if (!frame) {
    throw new Error(`expected thrown Vite stack to include ${jsPath}, got ${String(error.stack)}`);
  }
  console.log(frame.trim());
  process.exit(0);
}
throw new Error("expected Vite checkout probe to throw");
JS
)

release_artifacts_cli="$app_dir/node_modules/.bin/logbrew-release-artifacts"
symbolication_report="$tmp_dir/vite-symbolication-report.json"
"$release_artifacts_cli" symbolicate-js \
  --build-dir "$dist_dir" \
  --manifest "$ready_manifest" \
  --stack-frame "$(cat "$actual_stack_frame")" \
  > "$symbolication_report"

python3 - "$ready_manifest" "$js_file" "$map_file" "$symbolication_report" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[2]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
symbolication_report = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[5]
serialized_manifest = json.dumps(manifest)
serialized_symbolication = json.dumps(symbolication_report)

artifact = manifest["artifacts"][0]
debug_id = artifact["debugId"]

assert "debugId=" in bundle_source
assert source_map["debug_id"] == debug_id
assert "sourcesContent" not in source_map
assert all(tmp_dir not in source for source in source_map["sources"])
assert manifest["validation"]["status"] == "ready"
assert artifact["debugId"] == debug_id
assert artifact["sourceMap"]["hasSourcesContent"] is False
assert artifact["minifiedSource"]["minifiedUrl"].startswith("https://cdn.example/static/assets/")
assert symbolication_report["status"] == "resolved"
assert symbolication_report["debugId"] == debug_id
assert symbolication_report["generated"]["path"] == artifact["minifiedSource"]["path"]
assert symbolication_report["original"]["source"].endswith("src/main.js")
assert "cache=placeholder" not in serialized_manifest
assert "fragment" not in serialized_manifest
assert "LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_manifest
assert "checkout exploded" not in serialized_manifest
assert "checkout exploded" not in serialized_symbolication
assert tmp_dir not in serialized_manifest
assert tmp_dir not in serialized_symbolication
PY

port_file="$tmp_dir/fake-intake-port"
state_file="$tmp_dir/fake-intake-state.json"
expected_bearer="fake-vite-release-artifact-auth-value"

python3 "$repo_root/scripts/js_release_artifact_fake_intake.py" \
  --port-file "$port_file" \
  --state-file "$state_file" \
  --expected-bearer "$expected_bearer" \
  --source-sentinel "LOGBREW_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" \
  --query-placeholder "cache=placeholder" \
  --hash-fragment "fragment" &
server_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi
  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "fake Vite release-artifact intake did not start" >&2
  exit 1
fi

endpoint_base="http://127.0.0.1:$(cat "$port_file")"
export LOGBREW_RELEASE_ARTIFACT_TOKEN="$expected_bearer"
upload_report="$tmp_dir/vite-upload-report.json"
"$release_artifacts_cli" upload-js \
  --build-dir "$dist_dir" \
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

printf '%s\n' "real-user Vite release artifact plugin smoke ok"
