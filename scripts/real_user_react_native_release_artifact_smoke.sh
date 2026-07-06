#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
server_pid=""
export PYTHONDONTWRITEBYTECODE=1
export npm_config_cache="$tmp_dir/npm-cache"
export npm_config_update_notifier=false
export npm_config_fund=false
export npm_config_audit=false
export CI=true
unset NO_COLOR FORCE_COLOR

remove_tmp_dir() {
  if [[ -n "${server_pid:-}" ]]; then
    if kill "$server_pid" 2>/dev/null; then
      wait "$server_pid" 2>/dev/null || true
    fi
  fi
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

app_dir="$tmp_dir/react-native-artifact-app"
pack_dir="$tmp_dir/packs"
mkdir -p "$app_dir"
mkdir -p "$pack_dir"

sdk_pack_json="$tmp_dir/sdk-pack.json"
react_native_pack_json="$tmp_dir/react-native-pack.json"
(
  cd "$repo_root/js/logbrew-js"
  npm pack --silent --json --pack-destination "$pack_dir" > "$sdk_pack_json"
)
(
  cd "$repo_root/js/logbrew-react-native"
  npm pack --silent --json --pack-destination "$pack_dir" > "$react_native_pack_json"
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
}:
    assert expected in files, f"missing packed SDK release-artifact file: {expected}"
print(pack["filename"])
PY
)"
react_native_tgz="$(
  python3 - "$react_native_pack_json" <<'PY'
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
    assert expected in files, f"missing packed React Native release-artifact helper: {expected}"
print(pack["filename"])
PY
)"
sdk_tgz="$pack_dir/$sdk_tgz"
react_native_tgz="$pack_dir/$react_native_tgz"
cp "$sdk_tgz" "$tmp_dir/logbrew-sdk.tgz"
cp "$react_native_tgz" "$tmp_dir/logbrew-react-native.tgz"

react_native_version="$(npm view react-native version)"
react_version="$(npm view react version)"
react_native_cli_version="$(npm view @react-native-community/cli version)"
react_native_metro_config_version="$react_native_version"

cat > "$app_dir/package.json" <<JSON
{
  "private": true,
  "type": "commonjs",
  "dependencies": {
    "@logbrew/sdk": "file:../logbrew-sdk.tgz",
    "@logbrew/react-native": "file:../logbrew-react-native.tgz",
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
  npm ls @logbrew/sdk @logbrew/react-native react react-native @react-native-community/cli @react-native/metro-config >/dev/null
  node --input-type=module - <<'JS'
import { prepareLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";
import { uploadLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

if (typeof prepareLogBrewReactNativeReleaseArtifacts !== "function") {
  throw new Error("expected React Native release-artifact helper export");
}
if (typeof uploadLogBrewReactNativeReleaseArtifacts !== "function") {
  throw new Error("expected React Native release-artifact upload helper export");
}
JS
  node - <<'JS'
const {
  prepareLogBrewReactNativeReleaseArtifacts,
  uploadLogBrewReactNativeReleaseArtifacts,
  default: defaultExport,
} = require("@logbrew/react-native/release-artifacts");

if (
  typeof prepareLogBrewReactNativeReleaseArtifacts !== "function" ||
  typeof uploadLogBrewReactNativeReleaseArtifacts !== "function" ||
  defaultExport !== prepareLogBrewReactNativeReleaseArtifacts
) {
  throw new Error("expected CommonJS React Native release-artifact helper export");
}
JS
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

hermes_dist_dir="$app_dir/hermes-dist"
mkdir -p "$hermes_dist_dir"
hermes_bundle_file="$hermes_dist_dir/index.android.bundle"
hermes_map_file="$hermes_dist_dir/index.android.hermes.map"
cp "$bundle_file" "$hermes_bundle_file"
cp "$map_file" "$hermes_map_file"
python3 - "$hermes_bundle_file" <<'PY'
import re
import sys
from pathlib import Path

bundle_path = Path(sys.argv[1])
source = bundle_path.read_text(encoding="utf-8")
updated = re.sub(r"//# sourceMappingURL=[^\r\n]*", "//# sourceMappingURL=packager.map", source)
if updated == source:
    updated = f"{source.rstrip()}\n//# sourceMappingURL=packager.map\n"
bundle_path.write_text(updated, encoding="utf-8")
PY

hermes_manifest="$tmp_dir/react-native-hermes-manifest.json"
hermes_helper_report="$tmp_dir/react-native-hermes-helper-report.json"
(
  cd "$app_dir"
  node --input-type=module - "$hermes_bundle_file" "$hermes_map_file" "$app_dir_real" "$hermes_manifest" > "$hermes_helper_report" <<'JS'
import { prepareLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

const [, , bundle, sourcemap, root, manifestPath] = process.argv;
const result = prepareLogBrewReactNativeReleaseArtifacts({
  bundle,
  sourcemap,
  platform: "android",
  release: "2026.06.18-react-native-hermes",
  environment: "production",
  service: "checkout-react-native",
  root,
  manifestPath
});

process.stdout.write(JSON.stringify({
  manifestPath: result.manifestPath,
  manifestStatus: result.manifestReport.validation.status,
  artifactCount: result.manifestReport.artifacts.length,
  sourceMapPath: result.manifestReport.artifacts[0].sourceMap.path
}, null, 2));
JS
)

python3 - "$hermes_helper_report" "$hermes_manifest" "$hermes_bundle_file" "$hermes_map_file" "$app_dir_real" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
manifest = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[3]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
app_dir = sys.argv[5]

assert report["manifestStatus"] == "ready"
assert report["artifactCount"] == 1
assert report["sourceMapPath"] == "index.android.hermes.map"
assert manifest["artifacts"][0]["sourceMap"]["path"] == "index.android.hermes.map"
assert "sourceMappingURL=index.android.hermes.map" in bundle_source
assert "sourceMappingURL=packager.map" not in bundle_source
assert "sourcesContent" not in source_map
assert not any(isinstance(source, str) and source.startswith("/") for source in source_map["sources"])
assert app_dir not in json.dumps(source_map)
PY

ready_manifest="$tmp_dir/react-native-manifest.json"
helper_report="$tmp_dir/react-native-helper-report.json"
(
  cd "$app_dir"
  node --input-type=module - "$bundle_file" "$map_file" "$app_dir_real" "$ready_manifest" > "$helper_report" <<'JS'
import { prepareLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

const [, , bundle, sourcemap, root, manifestPath] = process.argv;
const result = prepareLogBrewReactNativeReleaseArtifacts({
  bundle,
  sourcemap,
  platform: "android",
  release: "2026.06.18-react-native",
  environment: "production",
  service: "checkout-react-native",
  root,
  manifestPath,
  minifiedPathPrefix: "app:///react-native?cache=placeholder#fragment"
});

process.stdout.write(JSON.stringify({
  buildDir: result.buildDir,
  bundlePath: result.bundlePath,
  sourcemapPath: result.sourcemapPath,
  manifestPath: result.manifestPath,
  prepareStatus: result.prepareReport.validation.status,
  writeApplied: result.prepareReport.writeApplied,
  manifestStatus: result.manifestReport.validation.status,
  artifactCount: result.manifestReport.artifacts.length
}, null, 2));
JS
)

python3 - "$helper_report" "$dist_dir" "$bundle_file" "$map_file" "$ready_manifest" <<'PY'
import json
import sys
from pathlib import Path

report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

assert Path(report["buildDir"]).name == Path(sys.argv[2]).name
assert Path(report["bundlePath"]).name == Path(sys.argv[3]).name
assert Path(report["sourcemapPath"]).name == Path(sys.argv[4]).name
assert Path(report["manifestPath"]).name == Path(sys.argv[5]).name
assert Path(report["bundlePath"]).parent.name == Path(sys.argv[2]).name
assert Path(report["sourcemapPath"]).parent.name == Path(sys.argv[2]).name
assert report["prepareStatus"] == "ready"
assert report["writeApplied"] is True
assert report["manifestStatus"] == "ready"
assert report["artifactCount"] == 1
PY

if grep -q "sourcesContent" "$map_file"; then
  echo "LogBrew React Native helper did not strip sourcesContent from the React Native source map" >&2
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
"$app_dir/node_modules/.bin/logbrew-release-artifacts" symbolicate-js \
  --build-dir "$dist_dir" \
  --manifest "$ready_manifest" \
  --stack-frame "$(cat "$generated_stack_frame")" \
  > "$symbolication_report"

python3 - "$ready_manifest" "$bundle_file" "$map_file" "$app_dir_real" "$symbolication_report" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
bundle_source = Path(sys.argv[2]).read_text(encoding="utf-8")
source_map = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
app_dir = sys.argv[4]
symbolication_report = json.loads(Path(sys.argv[5]).read_text(encoding="utf-8"))
serialized_manifest = json.dumps(manifest)
serialized_symbolication = json.dumps(symbolication_report)

artifact = manifest["artifacts"][0]
debug_id = artifact["debugId"]

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

runtime_issue_payload="$tmp_dir/react-native-runtime-issue.json"
(
  cd "$app_dir"
  node --input-type=module - "$ready_manifest" "$bundle_file" "$runtime_issue_payload" <<'JS'
import fs from "node:fs";
import {
  createLogBrewReactNativeClient,
  createReactNativeErrorEvent,
  createReactNativeTraceContext
} from "@logbrew/react-native";

const [, , manifestPath, bundlePath, outputPath] = process.argv;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const artifact = manifest.artifacts[0];
const source = fs.readFileSync(bundlePath, "utf8");
const needle = "react native checkout exploded";
const index = source.indexOf(needle);
if (index < 0) {
  throw new Error("expected minified React Native bundle to contain the checkout error marker");
}
const before = source.slice(0, index);
const line = before.split("\n").length;
const column = index - before.lastIndexOf("\n");
const debugId = artifact.debugId;
const runtimePath = `/react-native/${artifact.minifiedSource.path}`;
const runtimeUrl = `https://mobile.example.test${runtimePath}?logbrew_rn_query_placeholder=1#logbrew_rn_hash_placeholder`;
const trace = createReactNativeTraceContext({
  traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  spanId: "b7ad6b7169203331"
});
const error = new Error("react native checkout exploded 47");
error.stack = `Error: react native checkout exploded 47\n    at checkoutFailureSignal (${runtimeUrl}:${line}:${column})`;

const event = createReactNativeErrorEvent(error, {
  appState: { currentState: "active" },
  debugIdMap: {
    [runtimeUrl]: debugId,
    [runtimePath]: debugId,
    [artifact.minifiedSource.minifiedUrl]: debugId
  },
  environment: manifest.environment,
  platform: { OS: "android" },
  release: manifest.release,
  runtime: "react-native",
  screen: "Checkout",
  service: manifest.service,
  trace
});
const client = createLogBrewReactNativeClient({
  clientKey: "lbw_ingest_fake_react_native_runtime_key",
  sdkName: "react-native-release-artifact-smoke",
  sdkVersion: "0.1.0"
});
client.issue(event.id, event.timestamp, event.attributes);
const payload = JSON.parse(client.previewJson()).events[0];
fs.writeFileSync(outputPath, JSON.stringify({
  debugId,
  runtimeIssue: payload.attributes,
  runtimePath
}, null, 2));
JS
)

python3 - "$runtime_issue_payload" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[2]
debug_id = payload["debugId"]
runtime_issue = payload["runtimeIssue"]
runtime_path = payload["runtimePath"]
serialized_runtime_issue = json.dumps(runtime_issue)

assert runtime_issue["title"] == "React Native error: react native checkout exploded 47"
assert runtime_issue["message"] == "react native checkout exploded 47"
assert runtime_issue["level"] == "error"
assert runtime_issue["metadata"]["source"] == "react-native.error"
assert runtime_issue["metadata"]["release"] == "2026.06.18-react-native"
assert runtime_issue["metadata"]["environment"] == "production"
assert runtime_issue["metadata"]["service"] == "checkout-react-native"
assert runtime_issue["metadata"]["runtime"] == "react-native"
assert runtime_issue["metadata"]["platform"] == "android"
assert runtime_issue["metadata"]["appState"] == "active"
assert runtime_issue["metadata"]["screen"] == "Checkout"
assert runtime_issue["metadata"]["errorName"] == "Error"
assert runtime_issue["metadata"]["errorValueType"] == "object"
assert runtime_issue["metadata"]["releaseArtifactType"] == "sourcemap"
assert runtime_issue["metadata"]["releaseArtifactDebugId"] == debug_id
assert runtime_issue["metadata"]["releaseArtifactCodeFile"] == runtime_path
assert runtime_issue["metadata"]["errorFrameFile"] == runtime_path
assert runtime_issue["metadata"]["errorFrameLine"] > 0
assert runtime_issue["metadata"]["errorFrameColumn"] > 0
assert runtime_issue["metadata"]["issueGroupingKey"] == f"react-native.error:Error:{runtime_path}"
assert runtime_issue["metadata"]["issueGroupingSource"] == "error_type_and_frame"
assert runtime_issue["metadata"]["traceId"] == "4bf92f3577b34da6a3ce929d0e0e4736"
assert runtime_issue["metadata"]["parentSpanId"] == "00f067aa0ba902b7"
assert runtime_issue["metadata"]["spanId"] == "b7ad6b7169203331"
assert "mobile.example" not in serialized_runtime_issue
assert "logbrew_rn_query_placeholder" not in serialized_runtime_issue
assert "logbrew_rn_hash_placeholder" not in serialized_runtime_issue
assert "LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" not in serialized_runtime_issue
assert "errorStack" not in serialized_runtime_issue
assert tmp_dir not in serialized_runtime_issue
PY

port_file="$tmp_dir/fake-intake-port"
state_file="$tmp_dir/fake-intake-state.json"
expected_bearer="fake-react-native-release-artifact-auth-value"

python3 "$repo_root/scripts/js_release_artifact_fake_intake.py" \
  --port-file "$port_file" \
  --state-file "$state_file" \
  --expected-bearer "$expected_bearer" \
  --source-sentinel "LOGBREW_RN_LOCAL_SOURCE_SENTINEL_SHOULD_NOT_UPLOAD" \
  --query-placeholder "logbrew_rn_query_placeholder" \
  --hash-fragment "logbrew_rn_hash_placeholder" &
server_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi
  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "fake React Native release-artifact intake did not start" >&2
  exit 1
fi

endpoint_base="http://127.0.0.1:$(cat "$port_file")"
export LOGBREW_RELEASE_ARTIFACT_TOKEN="$expected_bearer"
upload_manifest="$tmp_dir/react-native-upload-manifest.json"
upload_helper_report="$tmp_dir/react-native-upload-helper-report.json"
hosted_upload_manifest="$tmp_dir/react-native-hosted-upload-manifest.json"
hosted_upload_helper_report="$tmp_dir/react-native-hosted-upload-helper-report.json"
(
  cd "$app_dir"
  node --input-type=module - "$bundle_file" "$map_file" "$app_dir_real" "$upload_manifest" "$endpoint_base/retry-success?logbrew_rn_query_placeholder=1#logbrew_rn_hash_placeholder" > "$upload_helper_report" <<'JS'
import { uploadLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

const [, , bundle, sourcemap, root, manifestPath, endpoint] = process.argv;
const result = uploadLogBrewReactNativeReleaseArtifacts({
  bundle,
  sourcemap,
  platform: "android",
  release: "2026.06.18-react-native-upload",
  environment: "production",
  service: "checkout-react-native",
  root,
  manifestPath,
  endpoint,
  maxRetries: 2,
  retryDelay: 0,
  timeout: 5
});

process.stdout.write(JSON.stringify({
  manifestStatus: result.manifestReport.validation.status,
  uploadStatus: result.uploadReport.status,
  retryCount: result.uploadReport.retryCount,
  attempts: result.uploadReport.attempts,
  endpoint: result.uploadReport.endpoint,
  artifactCount: result.uploadReport.artifactCount,
  filePartCount: result.uploadReport.filePartCount
}, null, 2));
JS
)

(
  cd "$app_dir"
  node --input-type=module - "$bundle_file" "$map_file" "$app_dir_real" "$hosted_upload_manifest" > "$hosted_upload_helper_report" <<'JS'
import { uploadLogBrewReactNativeReleaseArtifacts } from "@logbrew/react-native/release-artifacts";

const [, , bundle, sourcemap, root, manifestPath] = process.argv;
const result = uploadLogBrewReactNativeReleaseArtifacts({
  bundle,
  sourcemap,
  platform: "ios",
  release: "2026.06.18-react-native-hosted-upload",
  environment: "production",
  service: "checkout-react-native",
  root,
  manifestPath,
  endpoint: "https://api.logbrew.com/api/release-artifacts",
  allowHostedUpload: true,
  dryRun: true
});

process.stdout.write(JSON.stringify({
  manifestStatus: result.manifestReport.validation.status,
  uploadStatus: result.uploadReport.status,
  endpoint: result.uploadReport.endpoint,
  artifactCount: result.uploadReport.artifactCount,
  filePartCount: result.uploadReport.filePartCount
}, null, 2));
JS
)

python3 - "$upload_helper_report" "$hosted_upload_helper_report" "$state_file" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

upload_report = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
hosted_upload_report = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
state = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[4]

assert upload_report["manifestStatus"] == "ready"
assert upload_report["uploadStatus"] == "uploaded"
assert upload_report["retryCount"] == 1
assert [attempt["httpStatus"] for attempt in upload_report["attempts"]] == [503, 202]
assert upload_report["endpoint"].endswith("/retry-success")
assert upload_report["artifactCount"] == 1
assert upload_report["filePartCount"] == 2
assert "logbrew_rn_query_placeholder" not in json.dumps(upload_report)
assert hosted_upload_report["manifestStatus"] == "ready"
assert hosted_upload_report["uploadStatus"] == "dry_run"
assert hosted_upload_report["endpoint"] == "https://api.logbrew.com/api/release-artifacts"
assert hosted_upload_report["artifactCount"] == 1
assert hosted_upload_report["filePartCount"] == 2

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

printf 'real-user React Native release artifact smoke ok with react-native@%s react@%s cli@%s\n' \
  "$react_native_version" \
  "$react_version" \
  "$react_native_cli_version"
