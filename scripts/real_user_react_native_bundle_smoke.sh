#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
react_native_version="0.86.0"
react_version="19.2.3"
react_native_cli_version="20.1.0"
expo_version="57.0.8"
worklets_version="0.10.0"
expected_sdk_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
expected_react_native_package_version="$(node -p "require('${repo_root}/js/logbrew-react-native/package.json').version")"
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
    "expo@$expo_version" \
    "react@$react_version" \
    "react-native@$react_native_version" \
    "react-native-worklets@$worklets_version"

  installed_react_native="$(
    node -p "require('react-native/package.json').version"
  )"
  if [[ "$installed_react_native" != "$react_native_version" ]]; then
    echo "unexpected React Native version" >&2
    exit 1
  fi

  node --input-type=module - \
    "$expected_sdk_version" \
    "$expected_react_native_package_version" <<'NODE'
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
const sdkManifest = readManifest("@logbrew/sdk");
const reactNativeManifest = readManifest("@logbrew/react-native");

requireEqual(sdkManifest.version, expectedSdkVersion, "SDK version");
requireEqual(
  reactNativeManifest.version,
  expectedReactNativeVersion,
  "React Native package version"
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
requireEqual(
  reactNativeManifest.exports?.["./apple-native-diagnostics"]?.["react-native"]?.default,
  "./apple-native-diagnostics.js",
  "Apple native diagnostics entry"
);
requireEqual(
  reactNativeManifest.exports?.["./expo"]?.require?.default,
  "./expo.cjs",
  "Expo plugin CommonJS entry"
);

for (const relativePath of [
  "core.cjs",
  "react-native.d.ts",
  "react-native.js",
  "winston.cjs"
]) {
  requirePackedFile("@logbrew/sdk", relativePath);
}
for (const relativePath of [
  "index.native.d.ts",
  "index.native.js",
  "apple-native-diagnostics.d.ts",
  "apple-native-diagnostics.js",
  "expo.cjs",
  "expo.d.ts",
  "expo.js",
  "ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift",
  "ios/GeneratedAppleDiagnostics/SOURCE-MANIFEST.json",
  "metro.cjs",
  "metro.d.cts",
  "metro.d.ts",
  "metro.js"
]) {
  requirePackedFile("@logbrew/react-native", relativePath);
}
NODE

  python3 "$repo_root/scripts/check_npm_peer_compatibility.py" \
    "./node_modules/@logbrew/react-native/package.json" \
    "@logbrew/sdk=$expected_sdk_version"

  node <<'NODE'
const expo = require("@logbrew/react-native/expo");
const podfile = "target 'Example' do\n  use_expo_modules!\nend\n";
const once = expo.modifyPodfile(podfile);
if (
  typeof expo !== "function"
  || !once.includes("LogBrewReactNative/AppleNativeDiagnostics")
  || expo.modifyPodfile(once) !== once
) {
  throw new Error("installed Expo plugin did not add one idempotent diagnostics pod");
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

  cat > App.js <<'JS'
import React from "react";
import { View } from "react-native";
import { createLogBrewReactNativeClient } from "@logbrew/react-native";

const client = createLogBrewReactNativeClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkVersion: "0.0.0-test"
});
client.log("evt_rn_expo_bundle", "2026-07-30T12:00:00.000Z", {
  level: "info",
  message: "bounded Expo bundle smoke"
});

export default function App() {
  return React.createElement(View);
}
JS
  cat > app.json <<'JSON'
{
  "expo": {
    "name": "LogBrew Expo bundle smoke",
    "slug": "logbrew-expo-bundle-smoke",
    "version": "1.0.0",
    "jsEngine": "hermes"
  }
}
JSON
  cat > metro.config.js <<'JS'
const { getLogBrewExpoConfig } = require("@logbrew/react-native/metro");
const { getBundleModeMetroConfig } = require("react-native-worklets/bundleMode");

module.exports = getBundleModeMetroConfig(getLogBrewExpoConfig(__dirname));
JS

  ./node_modules/.bin/expo export \
    --output-dir "$fixture_root/expo-dist" \
    --platform android \
    --source-maps external \
    >/dev/null

  node --input-type=module - "$fixture_root/expo-dist" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const outputRoot = process.argv[2];
const metadata = JSON.parse(
  fs.readFileSync(path.join(outputRoot, "metadata.json"), "utf8")
);
const bundlePath = path.join(outputRoot, metadata.fileMetadata.android.bundle);
const mapPath = `${bundlePath}.map`;
const bytecode = fs.readFileSync(bundlePath);
const sourceMap = JSON.parse(fs.readFileSync(mapPath, "utf8"));
const debugId = sourceMap.debugId;

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(debugId)) {
  throw new Error("Expo source map is missing a valid Debug ID");
}
if (!bytecode.includes(Buffer.from(debugId))) {
  throw new Error("Expo Hermes bytecode is missing the source-map Debug ID");
}
if (!bytecode.includes(Buffer.from("@logbrew/react-native/debug-ids"))) {
  throw new Error("Expo Hermes bytecode is missing the LogBrew Debug ID registry");
}
if (bytecode.includes(Buffer.from("__LOGBREW_REACT_NATIVE_DEBUG_ID__"))) {
  throw new Error("Expo Hermes bytecode contains the unresolved LogBrew Debug ID placeholder");
}

process.stdout.write(JSON.stringify({
  expo: "57.0.8",
  expoDebugId: debugId,
  expoHermesRegistry: true,
  worklets: "0.10.0"
}) + "\n");
NODE
)
