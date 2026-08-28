#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
core_package="$repo_root/js/logbrew-js"
native_package="$repo_root/js/logbrew-react-native"
read -r minimum_sdk_version current_sdk_version <<<"$(
	bun -e '
    const native = await Bun.file(Bun.argv[1]).json();
    const core = await Bun.file(Bun.argv[2]).json();
    const match = /^\^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(native.peerDependencies?.["@logbrew/sdk"] ?? "");
    if (!match) throw new Error("@logbrew/react-native must declare an exact caret floor for @logbrew/sdk");
    process.stdout.write(`${match.slice(1).join(".")} ${core.version}`);
  ' "$native_package/package.json" "$core_package/package.json"
)"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rn-minimum-peer.XXXXXX")"

remove_fixture() {
	find "$fixture_root" -depth -delete
}
trap remove_fixture EXIT

native_tarball="$(cd "$native_package" && bun pm pack --quiet --ignore-scripts --destination "$fixture_root" | tail -n 1)"
sdk_tarball=""
if [[ "$minimum_sdk_version" == "$current_sdk_version" ]]; then
	sdk_tarball="$(cd "$core_package" && bun pm pack --quiet --ignore-scripts --destination "$fixture_root" | tail -n 1)"
fi
react_stub="$fixture_root/react"
mkdir "$react_stub"
bun -e '
  await Bun.write(`${Bun.argv[1]}/package.json`, JSON.stringify({name:"react",version:"18.3.1",main:"index.cjs"}));
  await Bun.write(`${Bun.argv[1]}/index.cjs`, "module.exports={createContext:()=>({Provider:{}}),createElement:()=>null,useContext:()=>null,useMemo:(value)=>value()};");
' "$react_stub"

consumer_root="$fixture_root/consumer"
mkdir -p "$consumer_root/node_modules/@logbrew/react-native"
if [[ -n "$sdk_tarball" ]]; then
	mkdir "$consumer_root/node_modules/@logbrew/sdk"
	tar -xzf "$sdk_tarball" -C "$consumer_root/node_modules/@logbrew/sdk" --strip-components=1
else
	bun -e 'await Bun.write(Bun.argv[1], JSON.stringify({name:"logbrew-rn-peer-smoke",private:true}))' "$consumer_root/package.json"
	bun --cwd "$consumer_root" add --no-save --ignore-scripts --silent "@logbrew/sdk@$minimum_sdk_version"
fi
tar -xzf "$native_tarball" -C "$consumer_root/node_modules/@logbrew/react-native" --strip-components=1
ln -s "$react_stub" "$consumer_root/node_modules/react"
cd "$consumer_root"

bun --eval '
  import { existsSync, readFileSync } from "node:fs";
  import path from "node:path";
  const minimumSdkVersion = Bun.argv[1];
  const packageRoot = path.resolve("node_modules/@logbrew/react-native");
  const sdkManifest = JSON.parse(readFileSync("node_modules/@logbrew/sdk/package.json", "utf8"));
  const nativeManifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const esm = await import("@logbrew/react-native");
  const esmReleaseArtifacts = await import("@logbrew/react-native/release-artifacts");
  const cjs = require("@logbrew/react-native");
  const cjsReleaseArtifacts = require("@logbrew/react-native/release-artifacts");
  if (
    sdkManifest.version !== minimumSdkVersion
    || nativeManifest.peerDependencies?.["@logbrew/sdk"] !== `^${minimumSdkVersion}`
    || [esm, cjs].some((module) => typeof module.createLogBrewReactNativeClient !== "function" || typeof module.captureReactNativeError !== "function")
    || [esmReleaseArtifacts, cjsReleaseArtifacts].some((module) => typeof module.prepareLogBrewReactNativeReleaseArtifacts !== "function")
    || !["apple-native-diagnostics.js", "ios/AppleDiagnostics/LBRNAppleNativeDiagnostics.swift"].every((file) => existsSync(path.join(packageRoot, file)))
  ) throw new Error("React Native minimum public peer smoke failed");
  console.log(`React Native minimum public peer smoke ok (@logbrew/sdk@${minimumSdkVersion})`);
' "$minimum_sdk_version"
