#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
react_native_version="0.86.0"
react_version="19.2.3"
react_native_cli_version="20.1.0"
expected_sdk_version="0.1.5"
expected_react_native_package_version="0.1.7"
expected_sdk_peer="^0.1.5"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rn-bundle.XXXXXX")"

remove_fixture() {
  rm -rf "$fixture_root"
}
trap remove_fixture EXIT

core_pack_json="$(
  npm pack "$repo_root/js/logbrew-js" \
    --json \
    --pack-destination "$fixture_root"
)"
native_pack_json="$(
  npm pack "$repo_root/js/logbrew-react-native" \
    --json \
    --pack-destination "$fixture_root"
)"
core_tarball="$fixture_root/$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1])[0].filename)' "$core_pack_json"
)"
native_tarball="$fixture_root/$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1])[0].filename)' "$native_pack_json"
)"

app_root="$fixture_root/app"
mkdir "$app_root"
(
  cd "$app_root"
  npm init --yes >/dev/null
  npm install \
    --silent \
    --ignore-scripts \
    --no-audit \
    --no-fund \
    --save-exact \
    "$core_tarball" \
    "$native_tarball" \
    "@babel/core@^7.25.2" \
    "@babel/runtime@^7.25.0" \
    "@react-native-community/cli@$react_native_cli_version" \
    "@react-native-community/cli-platform-android@$react_native_cli_version" \
    "@react-native/babel-preset@$react_native_version" \
    "@react-native/metro-config@$react_native_version" \
    "react@$react_version" \
    "react-native@$react_native_version"

  installed_react_native="$(
    node -p "require('react-native/package.json').version"
  )"
  if [[ "$installed_react_native" != "$react_native_version" ]]; then
    echo "unexpected React Native version" >&2
    exit 1
  fi

  node --input-type=module - \
    "$expected_sdk_version" \
    "$expected_react_native_package_version" \
    "$expected_sdk_peer" <<'NODE'
import fs from "node:fs";

function readManifest(packageName) {
  try {
    return JSON.parse(
      fs.readFileSync(`./node_modules/${packageName}/package.json`, "utf8")
    );
  } catch {
    throw new Error(`installed ${packageName} manifest is unavailable`);
  }
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`unexpected ${label}`);
  }
}

function requirePackedFile(packageName, relativePath) {
  if (!fs.existsSync(`./node_modules/${packageName}/${relativePath}`)) {
    throw new Error(`installed ${packageName} is missing ${relativePath}`);
  }
}

const expectedSdkVersion = process.argv[2];
const expectedReactNativeVersion = process.argv[3];
const expectedSdkPeer = process.argv[4];
const sdkManifest = readManifest("@logbrew/sdk");
const reactNativeManifest = readManifest("@logbrew/react-native");

requireEqual(sdkManifest.version, expectedSdkVersion, "SDK version");
requireEqual(
  reactNativeManifest.version,
  expectedReactNativeVersion,
  "React Native package version"
);
requireEqual(
  reactNativeManifest.peerDependencies?.["@logbrew/sdk"],
  expectedSdkPeer,
  "React Native SDK peer"
);
requireEqual(sdkManifest.reactNative, undefined, "SDK camel-case mobile field");
requireEqual(sdkManifest["react-native"], "./react-native.js", "SDK legacy mobile entry");
requireEqual(
  sdkManifest.exports?.["."]?.["react-native"]?.default,
  "./react-native.js",
  "SDK modern mobile entry"
);
requireEqual(
  reactNativeManifest["react-native"],
  "./index.native.js",
  "React Native legacy mobile entry"
);
requireEqual(
  reactNativeManifest.exports?.["."]?.["react-native"]?.default,
  "./index.native.js",
  "React Native modern mobile entry"
);

for (const relativePath of [
  "core.cjs",
  "react-native.d.ts",
  "react-native.js",
  "winston.cjs"
]) {
  requirePackedFile("@logbrew/sdk", relativePath);
}
for (const relativePath of ["index.native.d.ts", "index.native.js"]) {
  requirePackedFile("@logbrew/react-native", relativePath);
}
NODE

  node --conditions=react-native --input-type=module <<'NODE'
import { LogBrewClient } from "@logbrew/sdk";
import { createLogBrewReactNativeClient } from "./node_modules/@logbrew/react-native/index.js";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkVersion: "0.0.0-test"
});
if (!(client instanceof LogBrewClient)) {
  throw new Error("React Native adapter did not return the canonical client");
}
client.issue("evt_rn_bundle", "2026-07-25T12:00:00.000Z", {
  level: "error",
  message: "bounded release bundle smoke",
  title: "React Native bundle smoke"
});
if (client.pendingEvents() !== 1) {
  throw new Error("canonical client did not admit the smoke event");
}
NODE

  cat > index.js <<'JS'
import { createLogBrewReactNativeClient } from "@logbrew/react-native";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkVersion: "0.0.0-test"
});
client.issue("evt_rn_bundle", "2026-07-25T12:00:00.000Z", {
  level: "error",
  message: "bounded release bundle smoke",
  title: "React Native bundle smoke"
});
if (client.pendingEvents() !== 1) {
  throw new Error("canonical client did not admit the smoke event");
}
JS

  cat > babel.config.js <<'JS'
module.exports = {
  presets: ["module:@react-native/babel-preset"]
};
JS
  cat > metro.config.js <<'JS'
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

module.exports = mergeConfig(getDefaultConfig(__dirname), {});
JS

  ./node_modules/.bin/react-native bundle \
    --assets-dest "$fixture_root/assets" \
    --bundle-output "$fixture_root/index.android.bundle" \
    --dev false \
    --entry-file index.js \
    --minify true \
    --platform android \
    --sourcemap-output "$fixture_root/index.android.bundle.map" \
    >/dev/null

  cat > metro.config.js <<'JS'
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  resolver: {
    unstable_enablePackageExports: false
  }
});
JS
  ./node_modules/.bin/react-native bundle \
    --assets-dest "$fixture_root/legacy-assets" \
    --bundle-output "$fixture_root/legacy-index.android.bundle" \
    --dev false \
    --entry-file index.js \
    --minify true \
    --platform android \
    --sourcemap-output "$fixture_root/legacy-index.android.bundle.map" \
    >/dev/null

  node --input-type=module - \
    "$fixture_root/index.android.bundle.map" \
    "$fixture_root/legacy-index.android.bundle.map" <<'NODE'
import fs from "node:fs";

function inspectSourceMap(filename) {
  const sourceMap = JSON.parse(fs.readFileSync(filename, "utf8"));
  const sources = Array.isArray(sourceMap.sources) ? sourceMap.sources : [];
  const sourcesContent = Array.isArray(sourceMap.sourcesContent)
    ? sourceMap.sourcesContent
    : [];
  const sdkSources = sources
    .map((source, index) => ({ content: sourcesContent[index] ?? "", source }))
    .filter(({ source }) => source.includes("/node_modules/@logbrew/"));

  if (!sdkSources.some(({ source }) => source.endsWith("/@logbrew/sdk/react-native.js"))) {
    throw new Error("Metro did not select the React Native SDK entry");
  }
  if (!sdkSources.some(({ source }) => source.endsWith("/@logbrew/sdk/core.cjs"))) {
    throw new Error("Metro did not include the canonical SDK core");
  }
  if (sdkSources.some(({ source }) => /\/@logbrew\/sdk\/(?:node|winston)\.cjs$/u.test(source))) {
    throw new Error("Metro included a Node-only SDK adapter");
  }
  const builtinReferences = sdkSources.flatMap(({ content, source }) => {
    const matches = content.match(/(?:from\s+|require\(\s*)["']node:[^"']+/gu) ?? [];
    return matches.map((match) => ({ match, source }));
  });
  if (builtinReferences.length !== 0) {
    throw new Error("Metro included a Node builtin reference");
  }
  return {
    logbrewModules: sdkSources.length,
    nodeBuiltinReferences: builtinReferences.length
  };
}

const packageExports = inspectSourceMap(process.argv[2]);
const legacyMainField = inspectSourceMap(process.argv[3]);

process.stdout.write(JSON.stringify({
  canonicalClient: true,
  legacyMainField,
  packageExports,
  reactNative: "0.86.0"
}) + "\n");
NODE
)
