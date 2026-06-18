#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"

(
  cd "$repo_root/js/logbrew-js"
  npm pack --json --pack-destination "$tmp_dir" > "$tmp_dir/npm-pack.json"
)

package_tgz="$(node -e 'const fs = require("node:fs"); const item = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0]; process.stdout.write(item.filename);' "$tmp_dir/npm-pack.json")"
package_path="$tmp_dir/$package_tgz"

tar -tf "$package_path" > "$tmp_dir/package-contents.txt"
grep -q '^package/release-artifacts.js$' "$tmp_dir/package-contents.txt"
grep -q '^package/release-artifacts-symbolication.js$' "$tmp_dir/package-contents.txt"
tar -xOf "$package_path" package/package.json > "$tmp_dir/packed-package.json"

node - "$sdk_package_version" "$tmp_dir/packed-package.json" <<'EOF'
const fs = require("node:fs");

const expectedVersion = process.argv[2];
const packageJson = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
if (packageJson.version !== expectedVersion) {
  throw new Error(`unexpected packed version: ${packageJson.version}`);
}
if (packageJson.bin?.["logbrew-release-artifacts"] !== "./release-artifacts.js") {
  throw new Error(`unexpected package bin: ${JSON.stringify(packageJson.bin)}`);
}
if (!packageJson.files?.includes("release-artifacts.js")) {
  throw new Error("release-artifacts.js missing from package files list");
}
if (!packageJson.files?.includes("release-artifacts-symbolication.js")) {
  throw new Error("release-artifacts-symbolication.js missing from package files list");
}
EOF

cd "$tmp_dir"
npm init -y >/dev/null
npm install --ignore-scripts --no-audit --fund=false "$package_path" >/dev/null

test -x node_modules/.bin/logbrew-release-artifacts
node_modules/.bin/logbrew-release-artifacts --help > "$tmp_dir/cli-help.txt"
grep -q '^Usage:$' "$tmp_dir/cli-help.txt"
grep -q 'prepare-js --build-dir <dir>' "$tmp_dir/cli-help.txt"
grep -q 'manifest-js --build-dir <dir>' "$tmp_dir/cli-help.txt"
grep -q 'symbolicate-js --build-dir <dir>' "$tmp_dir/cli-help.txt"

app_root="$tmp_dir/checkout-app"
build_dir="$app_root/dist"
mkdir -p "$build_dir/assets" "$app_root/src"
cat > "$app_root/src/main.js" <<'JS'
export function checkout() {
  return "source fixture marker";
}
JS
cat > "$build_dir/assets/app.js" <<'JS'
function checkout(){throw new Error("source fixture marker")}checkout();
//# sourceMappingURL=app.js.map
JS
SOURCE_PATH="$app_root/src/main.js" node <<'EOF' > "$build_dir/assets/app.js.map"
const sourcePath = process.env.SOURCE_PATH;
process.stdout.write(`${JSON.stringify({
  version: 3,
  file: "app.js",
  sources: [sourcePath],
  sourcesContent: ['export function checkout() { return "source fixture marker"; }\n'],
  names: ["checkout"],
  mappings: "AAAA"
})}\n`);
EOF

node_modules/.bin/logbrew-release-artifacts \
  prepare-js \
  --build-dir "$build_dir" \
  --strip-sources-content \
  --strip-source-prefix "$app_root" \
  --write \
  > "$tmp_dir/prepare-report.json"

node_modules/.bin/logbrew-release-artifacts \
  manifest-js \
  --build-dir "$build_dir" \
  --release "checkout-web@1.2.3" \
  --environment production \
  --service checkout-web \
  --minified-path-prefix "https://cdn.example/assets?flag=debug#fragment" \
  --repository-url "https://github.com/example/checkout-web" \
  --commit-sha abc123 \
  > "$tmp_dir/manifest.json"

node_modules/.bin/logbrew-release-artifacts \
  symbolicate-js \
  --build-dir "$build_dir" \
  --manifest "$tmp_dir/manifest.json" \
  --stack-frame "at checkout (https://cdn.example/assets/assets/app.js:1:1)" \
  > "$tmp_dir/symbolicated-frame.json"

node - "$tmp_dir" "$build_dir" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const tmpDir = process.argv[2];
const buildDir = process.argv[3];
const prepareReport = JSON.parse(fs.readFileSync(path.join(tmpDir, "prepare-report.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, "manifest.json"), "utf8"));
const symbolicatedFrame = JSON.parse(fs.readFileSync(path.join(tmpDir, "symbolicated-frame.json"), "utf8"));
const minified = fs.readFileSync(path.join(buildDir, "assets", "app.js"), "utf8");
const sourceMap = JSON.parse(fs.readFileSync(path.join(buildDir, "assets", "app.js.map"), "utf8"));
const serialized = `${JSON.stringify(prepareReport)}\n${JSON.stringify(manifest)}\n${JSON.stringify(symbolicatedFrame)}`;

if (prepareReport.validation.status !== "ready") {
  throw new Error(`prepare-js was not ready: ${JSON.stringify(prepareReport.validation)}`);
}
if (prepareReport.writeApplied !== true) {
  throw new Error("prepare-js did not apply writes");
}
if (prepareReport.stripSourcePrefixCount !== 1) {
  throw new Error(`unexpected stripSourcePrefixCount: ${prepareReport.stripSourcePrefixCount}`);
}
if (manifest.validation.status !== "ready") {
  throw new Error(`manifest-js was not ready: ${JSON.stringify(manifest.validation)}`);
}
if (manifest.minifiedPathPrefix !== "https://cdn.example/assets") {
  throw new Error(`unsafe minified path prefix: ${manifest.minifiedPathPrefix}`);
}
const artifact = manifest.artifacts[0];
if (artifact.minifiedSource.minifiedUrl !== "https://cdn.example/assets/assets/app.js") {
  throw new Error(`unexpected minified URL: ${artifact.minifiedSource.minifiedUrl}`);
}
const debugId = minified.match(/debugId=([A-Za-z0-9-]+)/)?.[1];
if (!debugId || debugId !== sourceMap.debug_id) {
  throw new Error("minified source and source map debug IDs do not match");
}
if (artifact.debugId !== debugId || artifact.sourceMap.debugId !== debugId) {
  throw new Error("manifest debug IDs do not match prepared artifacts");
}
if (symbolicatedFrame.status !== "resolved") {
  throw new Error(`symbolicate-js failed: ${JSON.stringify(symbolicatedFrame)}`);
}
if (symbolicatedFrame.generated.path !== "assets/app.js" || symbolicatedFrame.original.source !== "src/main.js") {
  throw new Error(`unexpected symbolicated frame: ${JSON.stringify(symbolicatedFrame)}`);
}
if (symbolicatedFrame.original.line !== 1 || symbolicatedFrame.original.column !== 1) {
  throw new Error(`unexpected original position: ${JSON.stringify(symbolicatedFrame.original)}`);
}
if (sourceMap.sourcesContent !== undefined || artifact.sourceMap.hasSourcesContent !== false) {
  throw new Error("sourcesContent was not stripped");
}
if (sourceMap.sources.length !== 1 || sourceMap.sources[0] !== "src/main.js") {
  throw new Error(`source prefix was not stripped safely: ${JSON.stringify(sourceMap.sources)}`);
}
if (/source fixture marker|flag=debug|#fragment/.test(serialized)) {
  throw new Error("release artifact CLI report leaked source marker or URL data");
}
EOF

if node_modules/.bin/logbrew-release-artifacts manifest-js --build-dir "$tmp_dir/missing" --release x --environment production --service web --minified-path-prefix https://cdn.example >/dev/null 2> "$tmp_dir/missing.err"; then
  echo "expected missing build directory to fail" >&2
  exit 1
fi
grep -q 'build directory does not exist' "$tmp_dir/missing.err"

printf 'javascript release artifact installed CLI smoke ok (@logbrew/sdk %s)\n' "$sdk_package_version"
