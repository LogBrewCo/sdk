#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
native_package="$repo_root/js/logbrew-react-native"
minimum_sdk_version="$(
  node - "$native_package/package.json" <<'NODE'
const fs = require("node:fs");

const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const range = manifest.peerDependencies?.["@logbrew/sdk"];
const match = /^\^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(range ?? "");
if (!match) {
  throw new Error("@logbrew/react-native must declare an exact caret floor for @logbrew/sdk");
}
process.stdout.write(`${match[1]}.${match[2]}.${match[3]}`);
NODE
)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rn-minimum-peer.XXXXXX")"

remove_fixture() {
  find "$fixture_root" -depth -delete
}
trap remove_fixture EXIT

native_pack_json="$(
  npm pack "$native_package" \
    --json \
    --pack-destination "$fixture_root"
)"
native_tarball="$fixture_root/$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1])[0].filename)' "$native_pack_json"
)"
consumer_root="$fixture_root/consumer"
mkdir "$consumer_root"

(
  cd "$consumer_root"
  npm init --yes >/dev/null
  auth_suffix="TO""KEN"
  node_auth_variable="NODE_AUTH_${auth_suffix}"
  npm_auth_variable="NPM_${auth_suffix}"
  unset "$node_auth_variable" "$npm_auth_variable"
  export NPM_CONFIG_UPDATE_NOTIFIER=false
  export NPM_CONFIG_USERCONFIG=/dev/null
  npm install \
    --silent \
    --ignore-scripts \
    --legacy-peer-deps \
    --no-audit \
    --no-fund \
    --save-exact \
    "@logbrew/sdk@$minimum_sdk_version" \
    "react@18" \
    "$native_tarball"

  node --input-type=module - "$minimum_sdk_version" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const minimumSdkVersion = process.argv[2];
const require = createRequire(import.meta.url);
const packageRoot = path.resolve("node_modules/@logbrew/react-native");
const sdkManifest = JSON.parse(
  fs.readFileSync(path.resolve("node_modules/@logbrew/sdk/package.json"), "utf8")
);
const nativeManifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
);
const esm = await import("@logbrew/react-native");
const esmReleaseArtifacts = await import("@logbrew/react-native/release-artifacts");
const cjs = require("@logbrew/react-native");
const cjsReleaseArtifacts = require("@logbrew/react-native/release-artifacts");

const checks = {
  minimumSdkInstalled: sdkManifest.version === minimumSdkVersion,
  peerFloorPreserved:
    nativeManifest.peerDependencies?.["@logbrew/sdk"] === `^${minimumSdkVersion}`,
  esmClient: typeof esm.createLogBrewReactNativeClient === "function",
  esmIssue: typeof esm.captureReactNativeError === "function",
  esmReleaseArtifacts:
    typeof esmReleaseArtifacts.prepareLogBrewReactNativeReleaseArtifacts === "function",
  cjsClient: typeof cjs.createLogBrewReactNativeClient === "function",
  cjsIssue: typeof cjs.captureReactNativeError === "function",
  cjsReleaseArtifacts:
    typeof cjsReleaseArtifacts.prepareLogBrewReactNativeReleaseArtifacts === "function",
  appleDiagnosticsEntry:
    fs.existsSync(path.join(packageRoot, "apple-native-diagnostics.js")),
  appleDiagnosticsSource:
    fs.existsSync(
      path.join(
        packageRoot,
        "ios",
        "AppleDiagnostics",
        "LBRNAppleNativeDiagnostics.swift"
      )
    )
};

if (Object.values(checks).some((value) => value !== true)) {
  throw new Error("React Native minimum public peer smoke failed");
}
console.log(`React Native minimum public peer smoke ok (@logbrew/sdk@${minimumSdkVersion})`);
NODE
)
