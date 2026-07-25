#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_root="$repo_root/js/logbrew-react-native"
core_package_root="$repo_root/js/logbrew-js"
react_native_version="0.72.17"
fixture_root="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-rn-config-compatibility.XXXXXX")"

remove_fixture() {
  rm -rf "$fixture_root"
}
trap remove_fixture EXIT

core_tarball_json="$(
  npm pack "$core_package_root" \
    --json \
    --pack-destination "$fixture_root"
)"
core_tarball_name="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1])[0].filename)' "$core_tarball_json"
)"
core_tarball_path="$fixture_root/$core_tarball_name"
native_tarball_json="$(
  npm pack "$package_root" \
    --json \
    --pack-destination "$fixture_root"
)"
tarball_name="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1])[0].filename)' "$native_tarball_json"
)"
tarball_path="$fixture_root/$tarball_name"
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
    --legacy-peer-deps \
    "react@18.2.0" \
    "react-native@$react_native_version" \
    "$core_tarball_path" \
    "$tarball_path"

  installed_version="$(node -p "require('react-native/package.json').version")"
  if [[ "$installed_version" != "$react_native_version" ]]; then
    echo "expected React Native $react_native_version, found $installed_version" >&2
    exit 1
  fi
  if [[ "$(node -p "require('./node_modules/@logbrew/sdk/package.json')['react-native']")" != "./react-native.js" ]]; then
    echo "React Native legacy package entry is missing" >&2
    exit 1
  fi

  ./node_modules/.bin/react-native config > react-native-config.json
  node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const config = JSON.parse(fs.readFileSync("react-native-config.json", "utf8"));
const dependency = config.dependencies?.["@logbrew/react-native"];
if (!dependency) {
  throw new Error("React Native CLI did not resolve @logbrew/react-native");
}
const ios = dependency.platforms?.ios;
if (!ios?.podspecPath || path.basename(ios.podspecPath) !== "LogBrewReactNative.podspec") {
  throw new Error("React Native CLI did not resolve the LogBrew iOS podspec");
}
const android = dependency.platforms?.android;
if (
  android?.packageImportPath
    !== "import co.logbrew.reactnative.LogBrewReactNativePackage;"
  || android?.packageInstance !== "new LogBrewReactNativePackage()"
) {
  throw new Error("React Native CLI did not resolve the LogBrew Android package");
}
process.stdout.write(
  JSON.stringify({
    androidPackage: true,
    iosPodspec: true,
    reactNative: require("react-native/package.json").version
  }) + "\n"
);
NODE
)
