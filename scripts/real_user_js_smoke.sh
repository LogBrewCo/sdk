#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
sdk_package_tgz="logbrew-sdk-${sdk_package_version}.tgz"
export LOGBREW_JS_PACKAGE_TGZ="$sdk_package_tgz"
export LOGBREW_JS_PACKAGE_VERSION="$sdk_package_version"

run_installed_package_example() {
local example_path="$1"
local output_prefix="$2"

node "$example_path" > "$output_prefix.stdout.json" 2> "$output_prefix.stderr.json"
grep -q '"type": "release"' "$output_prefix.stdout.json"
grep -q '"type": "environment"' "$output_prefix.stdout.json"
grep -q '"type": "issue"' "$output_prefix.stdout.json"
grep -q '"type": "log"' "$output_prefix.stdout.json"
grep -q '"type": "span"' "$output_prefix.stdout.json"
grep -q '"type": "action"' "$output_prefix.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$output_prefix.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$output_prefix.stdout.json" >/dev/null
grep -q '"events":6' "$output_prefix.stderr.json"
grep -q '"ok":true' "$output_prefix.stderr.json"
}

run_installed_package_launcher() {
local launcher_arg="$1"
local output_prefix="$2"

if [[ -n "$launcher_arg" ]]; then
  node node_modules/@logbrew/sdk/examples/index.mjs "$launcher_arg" > "$output_prefix.stdout.json" 2> "$output_prefix.stderr.json"
else
  node node_modules/@logbrew/sdk/examples/index.mjs > "$output_prefix.stdout.json" 2> "$output_prefix.stderr.json"
fi
grep -q '"type": "release"' "$output_prefix.stdout.json"
grep -q '"type": "environment"' "$output_prefix.stdout.json"
grep -q '"type": "issue"' "$output_prefix.stdout.json"
grep -q '"type": "log"' "$output_prefix.stdout.json"
grep -q '"type": "span"' "$output_prefix.stdout.json"
grep -q '"type": "action"' "$output_prefix.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$output_prefix.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$output_prefix.stdout.json" >/dev/null
grep -q '"events":6' "$output_prefix.stderr.json"
grep -q '"ok":true' "$output_prefix.stderr.json"
}

check_installed_package_launcher_listing() {
local output_file="$1"

node node_modules/@logbrew/sdk/examples/index.mjs --list > "$output_file"
grep -qx 'readme-example -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example' <(sed -n '1p' "$output_file")
grep -qx 'readme-example:esm -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:esm' <(sed -n '2p' "$output_file")
grep -qx 'readme-example:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:cjs' <(sed -n '3p' "$output_file")
grep -qx 'real-user-smoke -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke' <(sed -n '4p' "$output_file")
grep -qx 'real-user-smoke:esm -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:esm' <(sed -n '5p' "$output_file")
grep -qx 'real-user-smoke:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:cjs' <(sed -n '6p' "$output_file")
grep -qx 'default (real-user-smoke) -> node node_modules/@logbrew/sdk/examples/index.mjs' <(sed -n '7p' "$output_file")
test "$(wc -l < "$output_file" | tr -d ' ')" = "7"
}

check_installed_package_launcher_help() {
local output_file="$1"

node node_modules/@logbrew/sdk/examples/index.mjs --help > "$output_file"
grep -q '^Usage: node node_modules/@logbrew/sdk/examples/index.mjs \[--list\] \[example\]$' "$output_file"
grep -q '^Run the packaged LogBrew SDK JavaScript examples that ship with the installed package\.$' "$output_file"
grep -q '^Launcher commands:$' "$output_file"
grep -q '^  readme-example -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example$' "$output_file"
grep -q '^  readme-example:esm -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:esm$' "$output_file"
grep -q '^  readme-example:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:cjs$' "$output_file"
grep -q '^  real-user-smoke -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke$' "$output_file"
grep -q '^  real-user-smoke:esm -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:esm$' "$output_file"
grep -q '^  real-user-smoke:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:cjs$' "$output_file"
grep -Fqx '  default (real-user-smoke) -> node node_modules/@logbrew/sdk/examples/index.mjs' <(grep '^  default ' "$output_file")
grep -q '^Package-manager helper commands:$' "$output_file"
grep -q '^  readme-example -> npm --prefix node_modules/@logbrew/sdk/examples run readme-example | pnpm --dir node_modules/@logbrew/sdk/examples run readme-example$' "$output_file"
grep -q '^  real-user-smoke -> npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke | pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke$' "$output_file"
}

run_installed_package_example_script() {
local package_manager="$1"
local script_name="$2"
local output_prefix="$3"
local examples_dir="node_modules/@logbrew/sdk/examples"

case "$package_manager" in
  npm)
    npm --prefix "$examples_dir" run --silent "$script_name" > "$output_prefix.stdout.json" 2> "$output_prefix.stderr.json"
    ;;
  pnpm)
    pnpm --dir "$examples_dir" run --silent "$script_name" > "$output_prefix.stdout.json" 2> "$output_prefix.stderr.json"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

grep -q '"type": "release"' "$output_prefix.stdout.json"
grep -q '"type": "environment"' "$output_prefix.stdout.json"
grep -q '"type": "issue"' "$output_prefix.stdout.json"
grep -q '"type": "log"' "$output_prefix.stdout.json"
grep -q '"type": "span"' "$output_prefix.stdout.json"
grep -q '"type": "action"' "$output_prefix.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$output_prefix.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$output_prefix.stdout.json" >/dev/null
grep -q '"events":6' "$output_prefix.stderr.json"
grep -q '"ok":true' "$output_prefix.stderr.json"
}

run_installed_package_example_help_command() {
local package_manager="$1"
local output_file="$2"
local examples_dir="node_modules/@logbrew/sdk/examples"

case "$package_manager" in
  npm)
    npm --prefix "$examples_dir" run help > "$output_file"
    ;;
  pnpm)
    pnpm --dir "$examples_dir" run help > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

grep -q '^Package-manager helper commands:$' "$output_file"
grep -q '^  readme-example -> npm --prefix node_modules/@logbrew/sdk/examples run readme-example | pnpm --dir node_modules/@logbrew/sdk/examples run readme-example$' "$output_file"
grep -q '^  readme-example:esm -> npm --prefix node_modules/@logbrew/sdk/examples run readme-example:esm | pnpm --dir node_modules/@logbrew/sdk/examples run readme-example:esm$' "$output_file"
grep -q '^  readme-example:cjs -> npm --prefix node_modules/@logbrew/sdk/examples run readme-example:cjs | pnpm --dir node_modules/@logbrew/sdk/examples run readme-example:cjs$' "$output_file"
grep -q '^  real-user-smoke -> npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke | pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke$' "$output_file"
grep -q '^  real-user-smoke:esm -> npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke:esm | pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke:esm$' "$output_file"
grep -q '^  real-user-smoke:cjs -> npm --prefix node_modules/@logbrew/sdk/examples run real-user-smoke:cjs | pnpm --dir node_modules/@logbrew/sdk/examples run real-user-smoke:cjs$' "$output_file"
}

run_installed_package_example_list_command() {
local package_manager="$1"
local output_file="$2"
local examples_dir="node_modules/@logbrew/sdk/examples"
local filtered_output

case "$package_manager" in
  npm)
    npm --prefix "$examples_dir" run list > "$output_file"
    ;;
  pnpm)
    pnpm --dir "$examples_dir" run list > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

filtered_output="$(mktemp)"
grep -E '^(readme-example|real-user-smoke|default \(real-user-smoke\))' "$output_file" > "$filtered_output"
grep -qx 'readme-example -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example' <(sed -n '1p' "$filtered_output")
grep -qx 'readme-example:esm -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:esm' <(sed -n '2p' "$filtered_output")
grep -qx 'readme-example:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs readme-example:cjs' <(sed -n '3p' "$filtered_output")
grep -qx 'real-user-smoke -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke' <(sed -n '4p' "$filtered_output")
grep -qx 'real-user-smoke:esm -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:esm' <(sed -n '5p' "$filtered_output")
grep -qx 'real-user-smoke:cjs -> node node_modules/@logbrew/sdk/examples/index.mjs real-user-smoke:cjs' <(sed -n '6p' "$filtered_output")
grep -qx 'default (real-user-smoke) -> node node_modules/@logbrew/sdk/examples/index.mjs' <(sed -n '7p' "$filtered_output")
test "$(wc -l < "$filtered_output" | tr -d ' ')" = "7"
rm -f "$filtered_output"
}

write_installed_package_example_script_listing() {
local package_manager="$1"
local output_file="$2"
local examples_dir="node_modules/@logbrew/sdk/examples"

case "$package_manager" in
  npm)
    npm --prefix "$examples_dir" run > "$output_file"
    grep -q 'npm run-script' "$output_file"
    ;;
  pnpm)
    pnpm --dir "$examples_dir" run > "$output_file"
    grep -q 'Commands available via "pnpm run":' "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

grep -q '^  help$' "$output_file"
grep -q '^  list$' "$output_file"
grep -q '^  readme-example$' "$output_file"
grep -q '^  readme-example:esm$' "$output_file"
grep -q '^  readme-example:cjs$' "$output_file"
grep -q '^  real-user-smoke$' "$output_file"
grep -q '^  real-user-smoke:esm$' "$output_file"
grep -q '^  real-user-smoke:cjs$' "$output_file"
}

write_package_tree() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    npm ls @logbrew/sdk --json > "$output_file"
    ;;
  pnpm)
    pnpm ls @logbrew/sdk --json > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

write_plain_package_tree() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    npm ls @logbrew/sdk > "$output_file"
    ;;
  pnpm)
    pnpm ls @logbrew/sdk > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

write_package_list() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    npm list --json --depth=0 > "$output_file"
    ;;
  pnpm)
    pnpm list --json --depth=0 > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

write_plain_package_list() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    npm list --depth=0 > "$output_file"
    ;;
  pnpm)
    pnpm list --depth=0 > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

write_dependency_explanation() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    npm explain @logbrew/sdk > "$output_file"
    ;;
  pnpm)
    pnpm why @logbrew/sdk > "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

run_package_manager_script() {
local package_manager="$1"
local script_name="$2"

case "$package_manager" in
  npm)
    npm run --silent "$script_name"
    ;;
  pnpm)
    pnpm run --silent "$script_name"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

assert_installed_package_surface() {
local package_tree_file="$1"

PACKAGE_TREE_FILE="$package_tree_file" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const payload = JSON.parse(fs.readFileSync(process.env.PACKAGE_TREE_FILE, "utf8"));
const root = Array.isArray(payload) ? payload[0] : payload;
const dependency = root?.dependencies?.["@logbrew/sdk"];

if (!dependency) {
  throw new Error("expected @logbrew/sdk in package tree");
}

const expectedSdkVersion = process.env.LOGBREW_JS_PACKAGE_VERSION;

if (dependency.version !== expectedSdkVersion) {
  throw new Error(`unexpected @logbrew/sdk version: ${dependency.version}`);
}

const packageJsonPath = path.join("node_modules", "@logbrew", "sdk", "package.json");
const readmePath = path.join("node_modules", "@logbrew", "sdk", "README.md");
const declarationsPath = path.join("node_modules", "@logbrew", "sdk", "index.d.ts");
const commonJsDeclarationsPath = path.join("node_modules", "@logbrew", "sdk", "index.d.cts");
const examplesPackageJsonPath = path.join("node_modules", "@logbrew", "sdk", "examples", "package.json");
const examplesLauncherPath = path.join("node_modules", "@logbrew", "sdk", "examples", "index.mjs");
const esmExamplePath = path.join("node_modules", "@logbrew", "sdk", "examples", "readme-example.mjs");
const cjsExamplePath = path.join("node_modules", "@logbrew", "sdk", "examples", "readme-example.cjs");
const realUserEsmExamplePath = path.join("node_modules", "@logbrew", "sdk", "examples", "real-user-smoke.mjs");
const realUserCjsExamplePath = path.join("node_modules", "@logbrew", "sdk", "examples", "real-user-smoke.cjs");
if (!fs.existsSync(readmePath)) {
  throw new Error("expected installed README.md");
}
if (!fs.existsSync(declarationsPath)) {
  throw new Error("expected installed index.d.ts");
}
if (!fs.existsSync(commonJsDeclarationsPath)) {
  throw new Error("expected installed index.d.cts");
}
if (!fs.existsSync(examplesPackageJsonPath)) {
  throw new Error("expected installed examples/package.json");
}
if (!fs.existsSync(examplesLauncherPath)) {
  throw new Error("expected installed examples/index.mjs");
}
if (!fs.existsSync(esmExamplePath)) {
  throw new Error("expected installed ESM example");
}
if (!fs.existsSync(cjsExamplePath)) {
  throw new Error("expected installed CommonJS example");
}
if (!fs.existsSync(realUserEsmExamplePath)) {
  throw new Error("expected installed ESM real-user smoke example");
}
if (!fs.existsSync(realUserCjsExamplePath)) {
  throw new Error("expected installed CommonJS real-user smoke example");
}

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const examplesPackageJson = JSON.parse(fs.readFileSync(examplesPackageJsonPath, "utf8"));
const readme = fs.readFileSync(readmePath, "utf8");
const declarations = fs.readFileSync(declarationsPath, "utf8");
const commonJsDeclarations = fs.readFileSync(commonJsDeclarationsPath, "utf8");

function assertPackageManifest(packageJson, label) {
  if (packageJson.sideEffects !== false) {
    throw new Error(`unexpected ${label} sideEffects flag: ${packageJson.sideEffects}`);
  }
  if (packageJson.engines?.node !== ">=18") {
    throw new Error(`unexpected ${label} node engine: ${packageJson.engines?.node}`);
  }
  if (packageJson.exports?.["."]?.import?.default !== "./index.js") {
    throw new Error(`unexpected ${label} import export: ${packageJson.exports?.["."]?.import?.default}`);
  }
  if (packageJson.exports?.["."]?.import?.types !== "./index.d.ts") {
    throw new Error(`unexpected ${label} import types export: ${packageJson.exports?.["."]?.import?.types}`);
  }
  if (packageJson.exports?.["."]?.require?.default !== "./index.cjs") {
    throw new Error(`unexpected ${label} require export: ${packageJson.exports?.["."]?.require?.default}`);
  }
  if (packageJson.exports?.["."]?.require?.types !== "./index.d.cts") {
    throw new Error(`unexpected ${label} require types export: ${packageJson.exports?.["."]?.require?.types}`);
  }
  if (packageJson.exports?.["."]?.default !== "./index.js") {
    throw new Error(`unexpected ${label} default export: ${packageJson.exports?.["."]?.default}`);
  }
  if (packageJson.exports?.["."]?.types !== undefined) {
    throw new Error(`unexpected ${label} flat types export: ${packageJson.exports?.["."]?.types}`);
  }
}

if (packageJson.name !== "@logbrew/sdk") {
  throw new Error(`unexpected installed package name: ${packageJson.name}`);
}
if (packageJson.version !== expectedSdkVersion) {
  throw new Error(`unexpected installed package version: ${packageJson.version}`);
}
if (packageJson.main !== "./index.cjs") {
  throw new Error(`unexpected installed main entry: ${packageJson.main}`);
}
if (packageJson.types !== "./index.d.ts") {
  throw new Error(`unexpected installed types entry: ${packageJson.types}`);
}
assertPackageManifest(packageJson, "installed");
if (examplesPackageJson.private !== true) {
  throw new Error(`unexpected installed examples package private flag: ${examplesPackageJson.private}`);
}
if (examplesPackageJson.type !== "module") {
  throw new Error(`unexpected installed examples package type: ${examplesPackageJson.type}`);
}
if (examplesPackageJson.scripts?.help !== "node ./index.mjs --help") {
  throw new Error(`unexpected installed examples help script: ${examplesPackageJson.scripts?.help}`);
}
if (examplesPackageJson.scripts?.list !== "node ./index.mjs --list") {
  throw new Error(`unexpected installed examples list script: ${examplesPackageJson.scripts?.list}`);
}
if (examplesPackageJson.scripts?.["readme-example"] !== "node ./index.mjs readme-example") {
  throw new Error(`unexpected installed examples default helper script: ${examplesPackageJson.scripts?.["readme-example"]}`);
}
if (examplesPackageJson.scripts?.["readme-example:esm"] !== "node ./index.mjs readme-example:esm") {
  throw new Error(`unexpected installed examples ESM helper script: ${examplesPackageJson.scripts?.["readme-example:esm"]}`);
}
if (examplesPackageJson.scripts?.["readme-example:cjs"] !== "node ./index.mjs readme-example:cjs") {
  throw new Error(`unexpected installed examples CommonJS helper script: ${examplesPackageJson.scripts?.["readme-example:cjs"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke"] !== "node ./index.mjs real-user-smoke") {
  throw new Error(`unexpected installed examples real-user-smoke helper script: ${examplesPackageJson.scripts?.["real-user-smoke"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke:esm"] !== "node ./index.mjs real-user-smoke:esm") {
  throw new Error(`unexpected installed examples real-user-smoke ESM helper script: ${examplesPackageJson.scripts?.["real-user-smoke:esm"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke:cjs"] !== "node ./index.mjs real-user-smoke:cjs") {
  throw new Error(`unexpected installed examples real-user-smoke CommonJS helper script: ${examplesPackageJson.scripts?.["real-user-smoke:cjs"]}`);
}
if (!readme.includes("npm install @logbrew/sdk")) {
  throw new Error("missing installed README npm install command");
}
if (!readme.includes("pnpm add @logbrew/sdk")) {
  throw new Error("missing installed README pnpm install command");
}
if (!readme.includes("LOGBREW_API_KEY")) {
  throw new Error("missing installed README fake API key placeholder");
}
if (!readme.includes("previewJson()")) {
  throw new Error("missing installed README previewJson guidance");
}
if (!readme.includes("parseTraceparent")) {
  throw new Error("missing installed README traceparent parse guidance");
}
if (!readme.includes("createTraceparent")) {
  throw new Error("missing installed README traceparent create guidance");
}
if (!readme.includes("spanAttributesFromTraceparent")) {
  throw new Error("missing installed README traceparent span guidance");
}
if (!readme.includes("createProductActionAttributes")) {
  throw new Error("missing installed README product action timeline guidance");
}
if (!readme.includes("createNetworkMilestoneAttributes")) {
  throw new Error("missing installed README network milestone timeline guidance");
}
if (!readme.includes("installLogBrewConsoleCapture")) {
  throw new Error("missing installed README console capture guidance");
}
if (!readme.includes("createLogBrewPinoDestination")) {
  throw new Error("missing installed README Pino destination guidance");
}
if (!readme.includes("createLogBrewWinstonTransport")) {
  throw new Error("missing installed README Winston transport guidance");
}
for (const needle of [
  "copyable examples",
  "keep the real key in your app configuration",
  "before sending",
  "Type declarations document payload shapes",
]) {
  if (!readme.includes(needle)) {
    throw new Error(`missing installed README service guidance: ${needle}`);
  }
}
if (!declarations.includes("Metadata values that can be attached to public LogBrew event payloads.")) {
  throw new Error("missing installed MetadataValue declaration docs");
}
if (!commonJsDeclarations.includes("Buffered public client for validating, previewing, and flushing LogBrew events.")) {
  throw new Error("missing installed CommonJS LogBrewClient declaration docs");
}
if (!declarations.includes("Structured metadata map shared by public LogBrew event attribute types.")) {
  throw new Error("missing installed Metadata declaration docs");
}
if (!declarations.includes("Parsed W3C trace context from a traceparent value.")) {
  throw new Error("missing installed TraceparentContext declaration docs");
}
if (!declarations.includes("Inputs for creating a W3C traceparent value from known trace/span ids.")) {
  throw new Error("missing installed TraceparentInput declaration docs");
}
if (!declarations.includes("Span fields supplied when deriving LogBrew span attributes from traceparent.")) {
  throw new Error("missing installed TraceparentSpanInput declaration docs");
}
if (!declarations.includes("Public release event attributes.")) {
  throw new Error("missing installed ReleaseAttributes declaration docs");
}
if (!declarations.includes("Public environment event attributes.")) {
  throw new Error("missing installed EnvironmentAttributes declaration docs");
}
if (!declarations.includes("Public issue event attributes.")) {
  throw new Error("missing installed IssueAttributes declaration docs");
}
if (!declarations.includes("Public log event attributes.")) {
  throw new Error("missing installed LogAttributes declaration docs");
}
if (!declarations.includes("Console method names supported by the opt-in console capture helper.")) {
  throw new Error("missing installed ConsoleMethodName declaration docs");
}
if (!declarations.includes("Configuration for opt-in console capture.")) {
  throw new Error("missing installed ConsoleCaptureConfig declaration docs");
}
if (!declarations.includes("Handle returned by opt-in console capture installation.")) {
  throw new Error("missing installed ConsoleCaptureHandle declaration docs");
}
if (!declarations.includes("Pino JSON log record shape accepted by the optional Pino destination helper.")) {
  throw new Error("missing installed PinoLogRecord declaration docs");
}
if (!declarations.includes("Configuration for the dependency-free Pino destination adapter.")) {
  throw new Error("missing installed PinoDestinationConfig declaration docs");
}
if (!declarations.includes("Stream-like destination returned for use as Pino's output destination.")) {
  throw new Error("missing installed PinoDestinationHandle declaration docs");
}
if (!declarations.includes("Winston info object shape accepted by the optional Winston transport helper.")) {
  throw new Error("missing installed WinstonLogInfo declaration docs");
}
if (!declarations.includes("Configuration for the dependency-free Winston transport adapter.")) {
  throw new Error("missing installed WinstonTransportConfig declaration docs");
}
if (!declarations.includes("Object-mode transport returned for use in a Winston logger's transports array.")) {
  throw new Error("missing installed WinstonTransportHandle declaration docs");
}
if (!declarations.includes("Public span event attributes.")) {
  throw new Error("missing installed SpanAttributes declaration docs");
}
if (!declarations.includes("Public action event attributes.")) {
  throw new Error("missing installed ActionAttributes declaration docs");
}
if (!declarations.includes("App-owned product step input for agent-readable action timelines.")) {
  throw new Error("missing installed ProductActionInput declaration docs");
}
if (!declarations.includes("App-owned API milestone input for agent-readable network timelines.")) {
  throw new Error("missing installed NetworkMilestoneInput declaration docs");
}
if (!declarations.includes("Shared timeline helper options for primitive app metadata.")) {
  throw new Error("missing installed TimelineAttributesOptions declaration docs");
}
if (!declarations.includes("Public metric event attributes. Use low-cardinality metadata only.")) {
  throw new Error("missing installed MetricAttributes declaration docs");
}
if (!declarations.includes("Public event union used in preview and transport payloads.")) {
  throw new Error("missing installed Event declaration docs");
}
if (!declarations.includes("Buffered public client for validating, previewing, and flushing LogBrew events.")) {
  throw new Error("missing installed LogBrewClient declaration docs");
}
if (!declarations.includes("Create a client from public SDK identity, retry, and API key settings.")) {
  throw new Error("missing installed create declaration docs");
}
if (!declarations.includes("Return the queued event batch as stable, pretty-printed JSON.")) {
  throw new Error("missing installed previewJson declaration docs");
}
if (!declarations.includes("Return the queued event count currently buffered in memory.")) {
  throw new Error("missing installed pendingEvents declaration docs");
}
if (!declarations.includes("Flush queued events through a transport while preserving retry semantics.")) {
  throw new Error("missing installed flush declaration docs");
}
if (!declarations.includes("Flush queued events, then mark the client closed so later writes fail.")) {
  throw new Error("missing installed shutdown declaration docs");
}
if (!declarations.includes("Install explicit console capture while preserving the target console's normal output behavior.")) {
  throw new Error("missing installed console capture declaration docs");
}
if (!declarations.includes("Create safe action attributes for an app-owned product step without automatic UI capture.")) {
  throw new Error("missing installed product action helper declaration docs");
}
if (!declarations.includes("Create safe action attributes for an app-owned network milestone without HTTP client patching.")) {
  throw new Error("missing installed network milestone helper declaration docs");
}
if (!declarations.includes("Convert console arguments into safe LogBrew log attributes without installing capture.")) {
  throw new Error("missing installed console attributes declaration docs");
}
if (!declarations.includes("Map a console method name to the corresponding LogBrew log level.")) {
  throw new Error("missing installed console level declaration docs");
}
if (!declarations.includes("Parse a W3C traceparent value into normalized trace/span context.")) {
  throw new Error("missing installed traceparent parse declaration docs");
}
if (!declarations.includes("Create a W3C traceparent value from explicit trace/span ids.")) {
  throw new Error("missing installed traceparent create declaration docs");
}
if (!declarations.includes("Build LogBrew span attributes that continue an incoming W3C traceparent value.")) {
  throw new Error("missing installed traceparent span declaration docs");
}
if (!declarations.includes("Create a dependency-free Pino destination that turns JSON log lines into queued LogBrew log events.")) {
  throw new Error("missing installed Pino destination declaration docs");
}
if (!declarations.includes("Convert a parsed Pino JSON log record into safe LogBrew log attributes without installing a destination.")) {
  throw new Error("missing installed Pino record declaration docs");
}
if (!declarations.includes("Create a dependency-free Winston object-mode transport that queues LogBrew log events.")) {
  throw new Error("missing installed Winston transport declaration docs");
}
if (!declarations.includes("Convert a Winston info object into safe LogBrew log attributes without installing a transport.")) {
  throw new Error("missing installed Winston info declaration docs");
}
if (!declarations.includes("Create a transport that accepts queued flushes with a 202 response.")) {
  throw new Error("missing installed alwaysAccept declaration docs");
}
if (!declarations.includes("Return the most recent request body sent through this transport.")) {
  throw new Error("missing installed lastBody declaration docs");
}
if (!declarations.includes("Create a retryable network failure that preserves queued events.")) {
  throw new Error("missing installed TransportError.network declaration docs");
}
if (!declarations.includes("Stable public SDK error with parseable code and message fields.")) {
  throw new Error("missing installed SdkError declaration docs");
}
if (!declarations.includes("Transport error that can optionally be marked retryable by the caller.")) {
  throw new Error("missing installed TransportError declaration docs");
}
if (!declarations.includes("Stable transport response returned from flush and shutdown operations.")) {
  throw new Error("missing installed TransportResponse declaration docs");
}
if (!declarations.includes("Final HTTP-like status returned by the transport.")) {
  throw new Error("missing installed TransportResponse.statusCode declaration docs");
}
if (!declarations.includes("Number of transport attempts used for the flush.")) {
  throw new Error("missing installed TransportResponse.attempts declaration docs");
}
if (!declarations.includes("Every request body sent through this transport instance.")) {
  throw new Error("missing installed RecordingTransport.sentBodies declaration docs");
}
EOF
}

assert_dependency_explanation() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    grep -q "^@logbrew/sdk@${sdk_package_version}$" "$output_file"
    grep -q '^node_modules/@logbrew/sdk$' "$output_file"
    grep -q '@logbrew/sdk@"file:' "$output_file"
    grep -q 'from the root project$' "$output_file"
    ;;
  pnpm)
    grep -q "^@logbrew/sdk@${sdk_package_version}$" "$output_file"
    grep -q '└── smoke-app@1.0.0 (dependencies)$' "$output_file"
    grep -q '^Found 1 version of @logbrew/sdk$' "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

assert_package_list() {
local package_manager="$1"
local output_file="$2"

PACKAGE_MANAGER="$package_manager" PACKAGE_LIST_FILE="$output_file" node <<'EOF'
const fs = require("node:fs");

const packageManager = process.env.PACKAGE_MANAGER;
const payload = JSON.parse(fs.readFileSync(process.env.PACKAGE_LIST_FILE, "utf8"));
const root = packageManager === "pnpm" ? payload[0] : payload;

if (!root || root.name !== "smoke-app") {
  throw new Error(`unexpected ${packageManager} package-list root: ${root?.name}`);
}
if (root.version !== "1.0.0") {
  throw new Error(`unexpected ${packageManager} package-list root version: ${root.version}`);
}
if (packageManager === "pnpm" && root.private !== true) {
  throw new Error(`unexpected ${packageManager} package-list private flag: ${root.private}`);
}

const dependencies = root.dependencies ?? {};
const sdk = dependencies["@logbrew/sdk"];
if (!sdk) {
  throw new Error(`missing ${packageManager} package-list sdk entry`);
}
const expectedSdkVersion = process.env.LOGBREW_JS_PACKAGE_VERSION;
const expectedSdkTarball = process.env.LOGBREW_JS_PACKAGE_TGZ;

if (sdk.version !== expectedSdkVersion) {
  throw new Error(`unexpected ${packageManager} sdk version: ${sdk.version}`);
}
if (typeof sdk.resolved !== "string" || !sdk.resolved.includes(expectedSdkTarball)) {
  throw new Error(`unexpected ${packageManager} sdk resolved value: ${sdk.resolved}`);
}

const typescript = dependencies.typescript;
if (!typescript) {
  throw new Error(`missing ${packageManager} package-list typescript entry`);
}
if (typescript.version !== "6.0.3") {
  throw new Error(`unexpected ${packageManager} typescript version: ${typescript.version}`);
}
const pino = dependencies.pino;
if (!pino) {
  throw new Error(`missing ${packageManager} package-list pino entry`);
}
if (pino.version !== "10.3.1") {
  throw new Error(`unexpected ${packageManager} pino version: ${pino.version}`);
}
const winston = dependencies.winston;
if (!winston) {
  throw new Error(`missing ${packageManager} package-list winston entry`);
}
if (winston.version !== "3.19.0") {
  throw new Error(`unexpected ${packageManager} winston version: ${winston.version}`);
}
EOF
}

assert_plain_package_list() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    grep -q '^smoke-app@1\.0\.0 .*$' "$output_file"
    grep -q "^├── @logbrew/sdk@${sdk_package_version}$" "$output_file"
    grep -q '^├── pino@10\.3\.1$' "$output_file"
    grep -q '^├── typescript@6\.0\.3$' "$output_file"
    grep -q '^└── winston@3\.19\.0$' "$output_file"
    ;;
  pnpm)
    grep -q '^Legend: production dependency, optional only, dev only$' "$output_file"
    grep -q '^smoke-app@1\.0\.0 .* (PRIVATE)$' "$output_file"
    grep -q '^│   dependencies:$' "$output_file"
    grep -q "^├── @logbrew/sdk@${sdk_package_version}$" "$output_file"
    grep -q '^├── pino@10\.3\.1$' "$output_file"
    grep -q '^├── typescript@6\.0\.3$' "$output_file"
    grep -q '^└── winston@3\.19\.0$' "$output_file"
    grep -q '^4 packages$' "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

assert_removed_package_surface() {
local package_manager="$1"
local output_file="$2"

PACKAGE_MANAGER="$package_manager" PACKAGE_LIST_FILE="$output_file" node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const packageManager = process.env.PACKAGE_MANAGER;
const payload = JSON.parse(fs.readFileSync(process.env.PACKAGE_LIST_FILE, "utf8"));
const root = packageManager === "pnpm" ? payload[0] : payload;

if (!root || root.name !== "smoke-app") {
  throw new Error(`unexpected ${packageManager} removed-package root: ${root?.name}`);
}
if (root.version !== "1.0.0") {
  throw new Error(`unexpected ${packageManager} removed-package root version: ${root.version}`);
}
if (packageManager === "pnpm" && root.private !== true) {
  throw new Error(`unexpected ${packageManager} removed-package private flag: ${root.private}`);
}

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (manifest.dependencies?.["@logbrew/sdk"] !== undefined) {
  throw new Error(`expected ${packageManager} manifest to remove @logbrew/sdk`);
}
if (manifest.dependencies?.typescript !== "^6.0.3") {
  throw new Error(`unexpected ${packageManager} manifest typescript dependency: ${manifest.dependencies?.typescript}`);
}
if (manifest.dependencies?.pino !== "^10.3.1") {
  throw new Error(`unexpected ${packageManager} manifest pino dependency: ${manifest.dependencies?.pino}`);
}
if (manifest.dependencies?.winston !== "^3.19.0") {
  throw new Error(`unexpected ${packageManager} manifest winston dependency: ${manifest.dependencies?.winston}`);
}

const dependencies = root.dependencies ?? {};
if (dependencies["@logbrew/sdk"]) {
  throw new Error(`expected ${packageManager} package list to remove @logbrew/sdk`);
}
const typescript = dependencies.typescript;
if (!typescript) {
  throw new Error(`missing ${packageManager} package-list typescript entry after removal`);
}
if (typescript.version !== "6.0.3") {
  throw new Error(`unexpected ${packageManager} typescript version after removal: ${typescript.version}`);
}
const pino = dependencies.pino;
if (!pino) {
  throw new Error(`missing ${packageManager} package-list pino entry after removal`);
}
if (pino.version !== "10.3.1") {
  throw new Error(`unexpected ${packageManager} pino version after removal: ${pino.version}`);
}
const winston = dependencies.winston;
if (!winston) {
  throw new Error(`missing ${packageManager} package-list winston entry after removal`);
}
if (winston.version !== "3.19.0") {
  throw new Error(`unexpected ${packageManager} winston version after removal: ${winston.version}`);
}

const installedSdkDir = path.join("node_modules", "@logbrew", "sdk");
if (fs.existsSync(installedSdkDir)) {
  throw new Error(`expected ${packageManager} installed package directory to be removed`);
}
EOF
}

assert_plain_removed_package_list() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    grep -q '^smoke-app@1\.0\.0 .*$' "$output_file"
    grep -q '^├── pino@10\.3\.1$' "$output_file"
    grep -q '^├── typescript@6\.0\.3$' "$output_file"
    grep -q '^└── winston@3\.19\.0$' "$output_file"
    if grep -q "@logbrew/sdk@${sdk_package_version}" "$output_file"; then
      echo "unexpected npm plain package list still contains @logbrew/sdk after uninstall" >&2
      exit 1
    fi
    ;;
  pnpm)
    grep -q '^Legend: production dependency, optional only, dev only$' "$output_file"
    grep -q '^smoke-app@1\.0\.0 .* (PRIVATE)$' "$output_file"
    grep -q '^│   dependencies:$' "$output_file"
    grep -q '^├── pino@10\.3\.1$' "$output_file"
    grep -q '^├── typescript@6\.0\.3$' "$output_file"
    grep -q '^└── winston@3\.19\.0$' "$output_file"
    grep -q '^3 packages$' "$output_file"
    if grep -q "@logbrew/sdk@${sdk_package_version}" "$output_file"; then
      echo "unexpected pnpm plain package list still contains @logbrew/sdk after removal" >&2
      exit 1
    fi
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

assert_plain_package_tree() {
local package_manager="$1"
local output_file="$2"

case "$package_manager" in
  npm)
    grep -q '^smoke-app@1\.0\.0 .*$' "$output_file"
    grep -q "^└── @logbrew/sdk@${sdk_package_version}$" "$output_file"
    ;;
  pnpm)
    grep -q '^Legend: production dependency, optional only, dev only$' "$output_file"
    grep -q '^smoke-app@1\.0\.0 .* (PRIVATE)$' "$output_file"
    grep -q '^│   dependencies:$' "$output_file"
    grep -q "^└── @logbrew/sdk@${sdk_package_version}$" "$output_file"
    grep -q '^1 package$' "$output_file"
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac
}

run_smoke_for_package_manager() {
local package_manager="$1"
local tmp_dir
local package_tgz

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' RETURN

cd "$tmp_dir"
case "$package_manager" in
  npm)
    npm init -y >/dev/null
    ;;
  pnpm)
    # pnpm 11.5.x can generate a range-style packageManager value that
    # Corepack rejects before the temporary app can be normalized.
    node <<'EOF'
const fs = require("node:fs");

fs.writeFileSync(
  "package.json",
  `${JSON.stringify(
    {
      name: "smoke-app",
      version: "1.0.0",
      private: true,
      type: "module"
    },
    null,
    2
  )}\n`
);
EOF
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

node <<'EOF'
const fs = require("node:fs");

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.name = "smoke-app";
packageJson.private = true;
packageJson.type = "module";
packageJson.scripts = {
  ...(packageJson.scripts ?? {}),
  "smoke-test": "node --test installed-user.test.mjs",
  "smoke-readme": "node readme-example.mjs",
  "smoke-types": "tsc --project tsconfig.json",
  "smoke-esm": "node smoke.mjs",
  "smoke-cjs": "node smoke-require.cjs"
};
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
EOF

package_tgz="$tmp_dir/$(cd "$repo_root/js/logbrew-js" && npm pack --quiet --pack-destination "$tmp_dir")"
(
  cd "$repo_root/js/logbrew-js"
  npm pack --dry-run --json > "$tmp_dir/npm-pack-dry-run.json"
  npm pack --json --pack-destination "$tmp_dir" > "$tmp_dir/npm-pack.json"
)
tar -tf "$package_tgz" > package-contents.txt
grep -q '^package/package.json$' package-contents.txt
grep -q '^package/README.md$' package-contents.txt
grep -q '^package/index.d.ts$' package-contents.txt
grep -q '^package/index.d.cts$' package-contents.txt
grep -q '^package/examples/package.json$' package-contents.txt
grep -q '^package/examples/readme-example.mjs$' package-contents.txt
grep -q '^package/examples/readme-example.cjs$' package-contents.txt
tar -xOf "$package_tgz" package/package.json > packed-package.json
tar -xOf "$package_tgz" package/README.md > packed-README.md
tar -xOf "$package_tgz" package/index.d.ts > packed-index.d.ts
tar -xOf "$package_tgz" package/index.d.cts > packed-index.d.cts
tar -xOf "$package_tgz" package/examples/package.json > packed-examples-package.json
node <<'EOF'
const fs = require("node:fs");

const dryRunMetadata = JSON.parse(fs.readFileSync("npm-pack-dry-run.json", "utf8"));
const packMetadata = JSON.parse(fs.readFileSync("npm-pack.json", "utf8"));

function validatePackMetadata(payload, label) {
  if (!Array.isArray(payload) || payload.length !== 1) {
    throw new Error(`unexpected ${label} payload: ${JSON.stringify(payload)}`);
  }
  const entry = payload[0];
  if (entry.name !== "@logbrew/sdk") {
    throw new Error(`unexpected ${label} name: ${entry.name}`);
  }
  const expectedSdkVersion = process.env.LOGBREW_JS_PACKAGE_VERSION;
  const expectedSdkTarball = process.env.LOGBREW_JS_PACKAGE_TGZ;

  if (entry.version !== expectedSdkVersion) {
    throw new Error(`unexpected ${label} version: ${entry.version}`);
  }
  if (entry.filename !== expectedSdkTarball) {
    throw new Error(`unexpected ${label} filename: ${entry.filename}`);
  }
  if (!Array.isArray(entry.files)) {
    throw new Error(`missing ${label} file list`);
  }
  const packedPaths = new Set(entry.files.map((item) => item.path));
  for (const requiredPath of ["README.md", "package.json", "index.d.ts", "index.d.cts", "index.js", "index.cjs", "examples/package.json", "examples/index.mjs", "examples/readme-example.mjs", "examples/readme-example.cjs", "examples/real-user-smoke.mjs", "examples/real-user-smoke.cjs"]) {
    if (!packedPaths.has(requiredPath)) {
      throw new Error(`missing ${label} file metadata for ${requiredPath}`);
    }
  }
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    throw new Error(`unexpected ${label} integrity: ${entry.integrity}`);
  }
  if (typeof entry.shasum !== "string" || entry.shasum.length !== 40) {
    throw new Error(`unexpected ${label} shasum: ${entry.shasum}`);
  }
  return entry;
}

const dryRunEntry = validatePackMetadata(dryRunMetadata, "npm pack --dry-run metadata");
const packEntry = validatePackMetadata(packMetadata, "npm pack metadata");
if (dryRunEntry.integrity !== packEntry.integrity) {
  throw new Error("npm pack dry-run integrity did not match actual pack output");
}
if (dryRunEntry.shasum !== packEntry.shasum) {
  throw new Error("npm pack dry-run shasum did not match actual pack output");
}
if (dryRunEntry.entryCount !== packEntry.entryCount) {
  throw new Error("npm pack dry-run entry count did not match actual pack output");
}

const packageJson = JSON.parse(fs.readFileSync("packed-package.json", "utf8"));
const examplesPackageJson = JSON.parse(fs.readFileSync("packed-examples-package.json", "utf8"));
const readme = fs.readFileSync("packed-README.md", "utf8");
const declarations = fs.readFileSync("packed-index.d.ts", "utf8");
const commonJsDeclarations = fs.readFileSync("packed-index.d.cts", "utf8");

function assertPackageManifest(packageJson, label) {
  if (packageJson.sideEffects !== false) {
    throw new Error(`unexpected ${label} sideEffects flag: ${packageJson.sideEffects}`);
  }
  if (packageJson.engines?.node !== ">=18") {
    throw new Error(`unexpected ${label} node engine: ${packageJson.engines?.node}`);
  }
  if (packageJson.exports?.["."]?.import?.default !== "./index.js") {
    throw new Error(`unexpected ${label} import export: ${packageJson.exports?.["."]?.import?.default}`);
  }
  if (packageJson.exports?.["."]?.import?.types !== "./index.d.ts") {
    throw new Error(`unexpected ${label} import types export: ${packageJson.exports?.["."]?.import?.types}`);
  }
  if (packageJson.exports?.["."]?.require?.default !== "./index.cjs") {
    throw new Error(`unexpected ${label} require export: ${packageJson.exports?.["."]?.require?.default}`);
  }
  if (packageJson.exports?.["."]?.require?.types !== "./index.d.cts") {
    throw new Error(`unexpected ${label} require types export: ${packageJson.exports?.["."]?.require?.types}`);
  }
  if (packageJson.exports?.["."]?.default !== "./index.js") {
    throw new Error(`unexpected ${label} default export: ${packageJson.exports?.["."]?.default}`);
  }
  if (packageJson.exports?.["."]?.types !== undefined) {
    throw new Error(`unexpected ${label} flat types export: ${packageJson.exports?.["."]?.types}`);
  }
}

if (packageJson.name !== "@logbrew/sdk") {
  throw new Error(`unexpected packed package name: ${packageJson.name}`);
}
const expectedSdkVersion = process.env.LOGBREW_JS_PACKAGE_VERSION;

if (packageJson.version !== expectedSdkVersion) {
  throw new Error(`unexpected packed package version: ${packageJson.version}`);
}
if (packageJson.main !== "./index.cjs") {
  throw new Error(`unexpected packed main entry: ${packageJson.main}`);
}
if (packageJson.types !== "./index.d.ts") {
  throw new Error(`unexpected packed types entry: ${packageJson.types}`);
}
assertPackageManifest(packageJson, "packed");
if (examplesPackageJson.private !== true) {
  throw new Error(`unexpected packed examples package private flag: ${examplesPackageJson.private}`);
}
if (examplesPackageJson.type !== "module") {
  throw new Error(`unexpected packed examples package type: ${examplesPackageJson.type}`);
}
if (examplesPackageJson.scripts?.help !== "node ./index.mjs --help") {
  throw new Error(`unexpected packed examples help script: ${examplesPackageJson.scripts?.help}`);
}
if (examplesPackageJson.scripts?.list !== "node ./index.mjs --list") {
  throw new Error(`unexpected packed examples list script: ${examplesPackageJson.scripts?.list}`);
}
if (examplesPackageJson.scripts?.["readme-example"] !== "node ./index.mjs readme-example") {
  throw new Error(`unexpected packed examples default helper script: ${examplesPackageJson.scripts?.["readme-example"]}`);
}
if (examplesPackageJson.scripts?.["readme-example:esm"] !== "node ./index.mjs readme-example:esm") {
  throw new Error(`unexpected packed examples ESM helper script: ${examplesPackageJson.scripts?.["readme-example:esm"]}`);
}
if (examplesPackageJson.scripts?.["readme-example:cjs"] !== "node ./index.mjs readme-example:cjs") {
  throw new Error(`unexpected packed examples CommonJS helper script: ${examplesPackageJson.scripts?.["readme-example:cjs"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke"] !== "node ./index.mjs real-user-smoke") {
  throw new Error(`unexpected packed examples real-user-smoke helper script: ${examplesPackageJson.scripts?.["real-user-smoke"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke:esm"] !== "node ./index.mjs real-user-smoke:esm") {
  throw new Error(`unexpected packed examples real-user-smoke ESM helper script: ${examplesPackageJson.scripts?.["real-user-smoke:esm"]}`);
}
if (examplesPackageJson.scripts?.["real-user-smoke:cjs"] !== "node ./index.mjs real-user-smoke:cjs") {
  throw new Error(`unexpected packed examples real-user-smoke CommonJS helper script: ${examplesPackageJson.scripts?.["real-user-smoke:cjs"]}`);
}
if (!readme.includes("npm install @logbrew/sdk")) {
  throw new Error("missing packed README npm install command");
}
if (!readme.includes("pnpm add @logbrew/sdk")) {
  throw new Error("missing packed README pnpm install command");
}
if (!readme.includes("LOGBREW_API_KEY")) {
  throw new Error("missing packed README fake API key placeholder");
}
if (!readme.includes("previewJson()")) {
  throw new Error("missing packed README previewJson guidance");
}
if (!readme.includes("parseTraceparent")) {
  throw new Error("missing packed README traceparent parse guidance");
}
if (!readme.includes("createTraceparent")) {
  throw new Error("missing packed README traceparent create guidance");
}
if (!readme.includes("spanAttributesFromTraceparent")) {
  throw new Error("missing packed README traceparent span guidance");
}
if (!readme.includes("installLogBrewConsoleCapture")) {
  throw new Error("missing packed README console capture guidance");
}
if (!readme.includes("createLogBrewPinoDestination")) {
  throw new Error("missing packed README Pino destination guidance");
}
if (!readme.includes("createLogBrewWinstonTransport")) {
  throw new Error("missing packed README Winston transport guidance");
}
for (const needle of [
  "copyable examples",
  "keep the real key in your app configuration",
  "before sending",
  "Type declarations document payload shapes",
]) {
  if (!readme.includes(needle)) {
    throw new Error(`missing packed README service guidance: ${needle}`);
  }
}
if (!declarations.includes("Metadata values that can be attached to public LogBrew event payloads.")) {
  throw new Error("missing packed MetadataValue declaration docs");
}
if (!commonJsDeclarations.includes("Buffered public client for validating, previewing, and flushing LogBrew events.")) {
  throw new Error("missing packed CommonJS LogBrewClient declaration docs");
}
if (!declarations.includes("Structured metadata map shared by public LogBrew event attribute types.")) {
  throw new Error("missing packed Metadata declaration docs");
}
if (!declarations.includes("Parsed W3C trace context from a traceparent value.")) {
  throw new Error("missing packed TraceparentContext declaration docs");
}
if (!declarations.includes("Inputs for creating a W3C traceparent value from known trace/span ids.")) {
  throw new Error("missing packed TraceparentInput declaration docs");
}
if (!declarations.includes("Span fields supplied when deriving LogBrew span attributes from traceparent.")) {
  throw new Error("missing packed TraceparentSpanInput declaration docs");
}
if (!declarations.includes("Public release event attributes.")) {
  throw new Error("missing packed ReleaseAttributes declaration docs");
}
if (!declarations.includes("Public environment event attributes.")) {
  throw new Error("missing packed EnvironmentAttributes declaration docs");
}
if (!declarations.includes("Public issue event attributes.")) {
  throw new Error("missing packed IssueAttributes declaration docs");
}
if (!declarations.includes("Public log event attributes.")) {
  throw new Error("missing packed LogAttributes declaration docs");
}
if (!declarations.includes("Console method names supported by the opt-in console capture helper.")) {
  throw new Error("missing packed ConsoleMethodName declaration docs");
}
if (!declarations.includes("Configuration for opt-in console capture.")) {
  throw new Error("missing packed ConsoleCaptureConfig declaration docs");
}
if (!declarations.includes("Handle returned by opt-in console capture installation.")) {
  throw new Error("missing packed ConsoleCaptureHandle declaration docs");
}
if (!declarations.includes("Pino JSON log record shape accepted by the optional Pino destination helper.")) {
  throw new Error("missing packed PinoLogRecord declaration docs");
}
if (!declarations.includes("Configuration for the dependency-free Pino destination adapter.")) {
  throw new Error("missing packed PinoDestinationConfig declaration docs");
}
if (!declarations.includes("Stream-like destination returned for use as Pino's output destination.")) {
  throw new Error("missing packed PinoDestinationHandle declaration docs");
}
if (!declarations.includes("Winston info object shape accepted by the optional Winston transport helper.")) {
  throw new Error("missing packed WinstonLogInfo declaration docs");
}
if (!declarations.includes("Configuration for the dependency-free Winston transport adapter.")) {
  throw new Error("missing packed WinstonTransportConfig declaration docs");
}
if (!declarations.includes("Object-mode transport returned for use in a Winston logger's transports array.")) {
  throw new Error("missing packed WinstonTransportHandle declaration docs");
}
if (!declarations.includes("Public span event attributes.")) {
  throw new Error("missing packed SpanAttributes declaration docs");
}
if (!declarations.includes("Public action event attributes.")) {
  throw new Error("missing packed ActionAttributes declaration docs");
}
if (!declarations.includes("Public metric event attributes. Use low-cardinality metadata only.")) {
  throw new Error("missing packed MetricAttributes declaration docs");
}
if (!declarations.includes("Public event union used in preview and transport payloads.")) {
  throw new Error("missing packed Event declaration docs");
}
if (!declarations.includes("Buffered public client for validating, previewing, and flushing LogBrew events.")) {
  throw new Error("missing packed LogBrewClient declaration docs");
}
if (!declarations.includes("Create a client from public SDK identity, retry, and API key settings.")) {
  throw new Error("missing packed create declaration docs");
}
if (!declarations.includes("Return the queued event batch as stable, pretty-printed JSON.")) {
  throw new Error("missing packed previewJson declaration docs");
}
if (!declarations.includes("Return the queued event count currently buffered in memory.")) {
  throw new Error("missing packed pendingEvents declaration docs");
}
if (!declarations.includes("Flush queued events through a transport while preserving retry semantics.")) {
  throw new Error("missing packed flush declaration docs");
}
if (!declarations.includes("Flush queued events, then mark the client closed so later writes fail.")) {
  throw new Error("missing packed shutdown declaration docs");
}
if (!declarations.includes("Install explicit console capture while preserving the target console's normal output behavior.")) {
  throw new Error("missing packed console capture declaration docs");
}
if (!declarations.includes("Convert console arguments into safe LogBrew log attributes without installing capture.")) {
  throw new Error("missing packed console attributes declaration docs");
}
if (!declarations.includes("Map a console method name to the corresponding LogBrew log level.")) {
  throw new Error("missing packed console level declaration docs");
}
if (!declarations.includes("Parse a W3C traceparent value into normalized trace/span context.")) {
  throw new Error("missing packed traceparent parse declaration docs");
}
if (!declarations.includes("Create a W3C traceparent value from explicit trace/span ids.")) {
  throw new Error("missing packed traceparent create declaration docs");
}
if (!declarations.includes("Build LogBrew span attributes that continue an incoming W3C traceparent value.")) {
  throw new Error("missing packed traceparent span declaration docs");
}
if (!declarations.includes("Create a dependency-free Pino destination that turns JSON log lines into queued LogBrew log events.")) {
  throw new Error("missing packed Pino destination declaration docs");
}
if (!declarations.includes("Convert a parsed Pino JSON log record into safe LogBrew log attributes without installing a destination.")) {
  throw new Error("missing packed Pino record declaration docs");
}
if (!declarations.includes("Create a dependency-free Winston object-mode transport that queues LogBrew log events.")) {
  throw new Error("missing packed Winston transport declaration docs");
}
if (!declarations.includes("Convert a Winston info object into safe LogBrew log attributes without installing a transport.")) {
  throw new Error("missing packed Winston info declaration docs");
}
if (!declarations.includes("Create a transport that accepts queued flushes with a 202 response.")) {
  throw new Error("missing packed alwaysAccept declaration docs");
}
if (!declarations.includes("Return the most recent request body sent through this transport.")) {
  throw new Error("missing packed lastBody declaration docs");
}
if (!declarations.includes("Create a retryable network failure that preserves queued events.")) {
  throw new Error("missing packed TransportError.network declaration docs");
}
if (!declarations.includes("Stable public SDK error with parseable code and message fields.")) {
  throw new Error("missing packed SdkError declaration docs");
}
if (!declarations.includes("Transport error that can optionally be marked retryable by the caller.")) {
  throw new Error("missing packed TransportError declaration docs");
}
if (!declarations.includes("Stable transport response returned from flush and shutdown operations.")) {
  throw new Error("missing packed TransportResponse declaration docs");
}
if (!declarations.includes("Final HTTP-like status returned by the transport.")) {
  throw new Error("missing packed TransportResponse.statusCode declaration docs");
}
if (!declarations.includes("Number of transport attempts used for the flush.")) {
  throw new Error("missing packed TransportResponse.attempts declaration docs");
}
if (!declarations.includes("Every request body sent through this transport instance.")) {
  throw new Error("missing packed RecordingTransport.sentBodies declaration docs");
}
EOF

case "$package_manager" in
  npm)
    npm install "$package_tgz" typescript pino winston >/dev/null
    test -f package-lock.json
    node - "$package_tgz" <<'EOF'
const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packMetadata = JSON.parse(fs.readFileSync("npm-pack.json", "utf8"));
if (!Array.isArray(packMetadata) || packMetadata.length !== 1) {
  throw new Error("unexpected npm pack metadata payload");
}
const packEntry = packMetadata[0];

if (manifest.name !== "smoke-app") {
  throw new Error(`unexpected npm manifest name: ${manifest.name}`);
}
if (manifest.type !== "module") {
  throw new Error(`unexpected npm manifest type: ${manifest.type}`);
}
if (manifest.scripts?.["smoke-test"] !== "node --test installed-user.test.mjs") {
  throw new Error(`unexpected npm smoke-test script: ${manifest.scripts?.["smoke-test"]}`);
}
if (manifest.scripts?.["smoke-readme"] !== "node readme-example.mjs") {
  throw new Error(`unexpected npm smoke-readme script: ${manifest.scripts?.["smoke-readme"]}`);
}
if (manifest.scripts?.["smoke-types"] !== "tsc --project tsconfig.json") {
  throw new Error(`unexpected npm smoke-types script: ${manifest.scripts?.["smoke-types"]}`);
}
if (manifest.scripts?.["smoke-esm"] !== "node smoke.mjs") {
  throw new Error(`unexpected npm smoke-esm script: ${manifest.scripts?.["smoke-esm"]}`);
}
if (manifest.scripts?.["smoke-cjs"] !== "node smoke-require.cjs") {
  throw new Error(`unexpected npm smoke-cjs script: ${manifest.scripts?.["smoke-cjs"]}`);
}
const manifestDeps = manifest.dependencies;
if (!manifestDeps || typeof manifestDeps["@logbrew/sdk"] !== "string") {
  throw new Error("missing npm manifest dependency for @logbrew/sdk");
}
if (!manifestDeps["@logbrew/sdk"].startsWith("file:")) {
  throw new Error(`unexpected npm manifest specifier: ${manifestDeps["@logbrew/sdk"]}`);
}
const expectedSdkTarball = process.env.LOGBREW_JS_PACKAGE_TGZ;
const expectedSdkVersion = process.env.LOGBREW_JS_PACKAGE_VERSION;

if (!manifestDeps["@logbrew/sdk"].endsWith(expectedSdkTarball)) {
  throw new Error(`unexpected npm manifest tarball target: ${manifestDeps["@logbrew/sdk"]}`);
}
if (manifestDeps.typescript !== "^6.0.3") {
  throw new Error(`unexpected npm manifest typescript specifier: ${manifestDeps.typescript}`);
}
if (manifestDeps.pino !== "^10.3.1") {
  throw new Error(`unexpected npm manifest pino specifier: ${manifestDeps.pino}`);
}
if (manifestDeps.winston !== "^3.19.0") {
  throw new Error(`unexpected npm manifest winston specifier: ${manifestDeps.winston}`);
}

if (lock.lockfileVersion !== 3) {
  throw new Error(`unexpected npm lockfileVersion: ${lock.lockfileVersion}`);
}

const rootDeps = lock.packages?.[""]?.dependencies;
if (!rootDeps || typeof rootDeps["@logbrew/sdk"] !== "string") {
  throw new Error("missing npm root dependency for @logbrew/sdk");
}
if (!rootDeps["@logbrew/sdk"].startsWith("file:")) {
  throw new Error(`unexpected npm root specifier: ${rootDeps["@logbrew/sdk"]}`);
}
if (!rootDeps["@logbrew/sdk"].endsWith(expectedSdkTarball)) {
  throw new Error(`unexpected npm root tarball target: ${rootDeps["@logbrew/sdk"]}`);
}

const pkg = lock.packages?.["node_modules/@logbrew/sdk"];
if (!pkg) {
  throw new Error("missing npm lock package entry for @logbrew/sdk");
}
if (pkg.version !== expectedSdkVersion) {
  throw new Error(`unexpected npm lock package version: ${pkg.version}`);
}
if (pkg.license !== "MIT") {
  throw new Error(`unexpected npm lock package license: ${pkg.license}`);
}
if (typeof pkg.resolved !== "string" || !pkg.resolved.startsWith("file:")) {
  throw new Error(`unexpected npm lock resolved value: ${pkg.resolved}`);
}
if (!pkg.resolved.endsWith(expectedSdkTarball)) {
  throw new Error(`unexpected npm lock resolved tarball: ${pkg.resolved}`);
}
if (typeof pkg.integrity !== "string" || !pkg.integrity.startsWith("sha512-")) {
  throw new Error(`unexpected npm lock integrity: ${pkg.integrity}`);
}
if (pkg.integrity !== packEntry.integrity) {
  throw new Error("npm lock integrity did not match npm pack metadata");
}
EOF
    write_package_tree "$package_manager" package-tree.json
    ;;
  pnpm)
    pnpm add "$package_tgz" typescript pino winston >/dev/null
    test -f pnpm-lock.yaml
    node <<'EOF'
const fs = require("node:fs");
const lock = fs.readFileSync("pnpm-lock.yaml", "utf8");
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const packMetadata = JSON.parse(fs.readFileSync("npm-pack.json", "utf8"));
if (!Array.isArray(packMetadata) || packMetadata.length !== 1) {
  throw new Error("unexpected npm pack metadata payload");
}
const packEntry = packMetadata[0];

if (manifest.name !== "smoke-app") {
  throw new Error(`unexpected pnpm manifest name: ${manifest.name}`);
}
if (manifest.type !== "module") {
  throw new Error(`unexpected pnpm manifest type: ${manifest.type}`);
}
if (manifest.scripts?.["smoke-test"] !== "node --test installed-user.test.mjs") {
  throw new Error(`unexpected pnpm smoke-test script: ${manifest.scripts?.["smoke-test"]}`);
}
if (manifest.scripts?.["smoke-readme"] !== "node readme-example.mjs") {
  throw new Error(`unexpected pnpm smoke-readme script: ${manifest.scripts?.["smoke-readme"]}`);
}
if (manifest.scripts?.["smoke-types"] !== "tsc --project tsconfig.json") {
  throw new Error(`unexpected pnpm smoke-types script: ${manifest.scripts?.["smoke-types"]}`);
}
if (manifest.scripts?.["smoke-esm"] !== "node smoke.mjs") {
  throw new Error(`unexpected pnpm smoke-esm script: ${manifest.scripts?.["smoke-esm"]}`);
}
if (manifest.scripts?.["smoke-cjs"] !== "node smoke-require.cjs") {
  throw new Error(`unexpected pnpm smoke-cjs script: ${manifest.scripts?.["smoke-cjs"]}`);
}
const manifestDeps = manifest.dependencies;
if (!manifestDeps || typeof manifestDeps["@logbrew/sdk"] !== "string") {
  throw new Error("missing pnpm manifest dependency for @logbrew/sdk");
}
if (!manifestDeps["@logbrew/sdk"].startsWith("file:")) {
  throw new Error(`unexpected pnpm manifest specifier: ${manifestDeps["@logbrew/sdk"]}`);
}
const expectedSdkTarball = process.env.LOGBREW_JS_PACKAGE_TGZ;

if (!manifestDeps["@logbrew/sdk"].endsWith(expectedSdkTarball)) {
  throw new Error(`unexpected pnpm manifest tarball target: ${manifestDeps["@logbrew/sdk"]}`);
}
if (manifestDeps.typescript !== "^6.0.3") {
  throw new Error(`unexpected pnpm manifest typescript specifier: ${manifestDeps.typescript}`);
}
if (manifestDeps.pino !== "^10.3.1") {
  throw new Error(`unexpected pnpm manifest pino specifier: ${manifestDeps.pino}`);
}
if (manifestDeps.winston !== "^3.19.0") {
  throw new Error(`unexpected pnpm manifest winston specifier: ${manifestDeps.winston}`);
}

if (!lock.includes("lockfileVersion: '9.0'")) {
  throw new Error("unexpected pnpm lockfileVersion");
}
if (!lock.includes("'@logbrew/sdk':")) {
  throw new Error("missing pnpm importer dependency for @logbrew/sdk");
}
if (!lock.includes("specifier: file:")) {
  throw new Error("missing pnpm file specifier for @logbrew/sdk");
}
if (!lock.includes("version: file:")) {
  throw new Error("missing pnpm file version for @logbrew/sdk");
}
if (!lock.includes(expectedSdkTarball)) {
  throw new Error("missing pnpm tarball target for @logbrew/sdk");
}
if (!lock.includes("resolution: {integrity: sha512-")) {
  throw new Error("missing pnpm integrity resolution for @logbrew/sdk");
}
if (!lock.includes(`resolution: {integrity: ${packEntry.integrity}, tarball: file:`)) {
  throw new Error("pnpm lock integrity did not match npm pack metadata");
}
EOF
    write_package_tree "$package_manager" package-tree.json
    ;;
  *)
    echo "unsupported package manager: $package_manager" >&2
    exit 1
    ;;
esac

assert_installed_package_surface package-tree.json
write_plain_package_tree "$package_manager" package-tree-plain.txt
assert_plain_package_tree "$package_manager" package-tree-plain.txt
write_plain_package_list "$package_manager" package-list-plain.txt
assert_plain_package_list "$package_manager" package-list-plain.txt
write_package_list "$package_manager" package-list.json
assert_package_list "$package_manager" package-list.json
write_dependency_explanation "$package_manager" dependency-explanation.txt
assert_dependency_explanation "$package_manager" dependency-explanation.txt

case "$package_manager" in
  npm)
    npm uninstall @logbrew/sdk >/dev/null
    ;;
  pnpm)
    pnpm remove @logbrew/sdk >/dev/null
    ;;
esac

write_plain_package_list "$package_manager" package-list-removed-plain.txt
assert_plain_removed_package_list "$package_manager" package-list-removed-plain.txt
write_package_list "$package_manager" package-list-removed.json
assert_removed_package_surface "$package_manager" package-list-removed.json

case "$package_manager" in
  npm)
    npm install "$package_tgz" >/dev/null
    ;;
  pnpm)
    pnpm add "$package_tgz" >/dev/null
    ;;
esac

write_package_tree "$package_manager" package-tree-readded.json
assert_installed_package_surface package-tree-readded.json
write_plain_package_tree "$package_manager" package-tree-plain-readded.txt
assert_plain_package_tree "$package_manager" package-tree-plain-readded.txt
write_plain_package_list "$package_manager" package-list-readded-plain.txt
assert_plain_package_list "$package_manager" package-list-readded-plain.txt
write_package_list "$package_manager" package-list-readded.json
assert_package_list "$package_manager" package-list-readded.json
write_dependency_explanation "$package_manager" dependency-explanation-readded.txt
assert_dependency_explanation "$package_manager" dependency-explanation-readded.txt

cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "noEmit": true
  },
  "include": ["types-smoke.ts", "types-smoke.cts"]
}
EOF

cat > types-smoke.ts <<'EOF'
import {
  createNetworkMilestoneAttributes,
  createProductActionAttributes,
  createTraceparent,
  createTraceparentHeaders,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  parseTraceparent,
  RecordingTransport,
  spanAttributesFromTraceparent,
  type ActionAttributes,
  type ConsoleCaptureConfig,
  type ConsoleCaptureHandle,
  type ConsoleMethodName,
  type EnvironmentAttributes,
  type EventFilter,
  type IssueAttributes,
  type LogAttributes,
  type MetricAttributes,
  type NetworkMilestoneInput,
  type PinoDestinationConfig,
  type PinoDestinationHandle,
  type PinoLogRecord,
  type ProductActionInput,
  type ReleaseAttributes,
  type SpanAttributes,
  type TimelineAttributesOptions,
  type TraceparentContext,
  type TraceparentInput,
  type TraceparentSpanInput,
  type TransportResponse,
  type WinstonLogInfo,
  type WinstonTransportConfig,
  type WinstonTransportHandle
} from "@logbrew/sdk";

const release: ReleaseAttributes = {
  version: "1.2.3",
  commit: "abc123def456"
};
const environment: EnvironmentAttributes = {
  name: "production",
  region: "global"
};
const issue: IssueAttributes = {
  title: "Checkout timeout",
  level: "error",
  message: "Request timed out after retry budget"
};
const log: LogAttributes = {
  message: "worker started",
  level: "info",
  logger: "job-runner"
};
const span: SpanAttributes = {
  name: "GET /health",
  traceId: "trace_001",
  spanId: "span_001",
  status: "ok",
  durationMs: 12.5
};
const action: ActionAttributes = {
  name: "deploy",
  status: "success"
};
const productAction: ProductActionInput = {
  name: "checkout.submit",
  status: "running",
  sessionId: "sess_123",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  routeTemplate: "/checkout/:step",
  funnel: "checkout",
  step: "submit",
  metadata: { service: "checkout" }
};
const networkMilestone: NetworkMilestoneInput = {
  routeTemplate: "/payments/:id",
  method: "POST",
  statusCode: 202,
  durationMs: 94,
  sessionId: "sess_123",
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  metadata: { service: "checkout" }
};
const timelineOptions: TimelineAttributesOptions = {
  metadata: { region: "global" }
};
const metric: MetricAttributes = {
  name: "checkout.requests",
  kind: "counter",
  value: 42,
  unit: "{request}",
  temporality: "delta",
  metadata: { service: "checkout" }
};
const eventFilter: EventFilter = (event) => event.type !== "log" || event.attributes.level !== "info";

async function main() {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "smoke-app-types",
    sdkVersion: "0.1.0",
    eventFilter
  });
  client.release("evt_release_001", "2026-06-02T10:00:00Z", release);
  client.environment("evt_environment_001", "2026-06-02T10:00:01Z", environment);
  client.issue("evt_issue_001", "2026-06-02T10:00:02Z", issue);
  client.log("evt_log_001", "2026-06-02T10:00:03Z", log);
  client.span("evt_span_001", "2026-06-02T10:00:04Z", span);
  client.action("evt_action_001", "2026-06-02T10:00:05Z", action);
  client.metric("evt_metric_001", "2026-06-02T10:00:06Z", metric);
  const response: TransportResponse = await client.flush(RecordingTransport.alwaysAccept());
  if (response.statusCode !== 202) {
    throw new Error("unexpected status");
  }
  const traceContext: TraceparentContext = parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
  const traceInput: TraceparentInput = {
    traceId: traceContext.traceId,
    spanId: "b7ad6b7169203331"
  };
  const continuedSpanInput: TraceparentSpanInput = {
    name: "GET /checkout",
    spanId: traceInput.spanId,
    status: "ok",
    metadata: { service: "checkout" }
  };
  const continuedSpan: SpanAttributes = spanAttributesFromTraceparent(
    createTraceparent(traceInput),
    continuedSpanInput
  );
  const outgoingHeaders: { traceparent: string } = createTraceparentHeaders(traceInput);
  const productTimelineAction: ActionAttributes = createProductActionAttributes(productAction, timelineOptions);
  const networkTimelineAction: ActionAttributes = createNetworkMilestoneAttributes(networkMilestone, timelineOptions);
  if (productTimelineAction.metadata?.routeTemplate !== "/checkout/:step") {
    throw new Error("unexpected product timeline route template");
  }
  if (networkTimelineAction.metadata?.method !== "POST") {
    throw new Error("unexpected network timeline method");
  }
  if (continuedSpan.traceId !== traceContext.traceId || continuedSpan.parentSpanId !== traceInput.spanId) {
    throw new Error("unexpected trace context");
  }
  if (outgoingHeaders.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
    throw new Error("unexpected traceparent carrier");
  }
  const consoleMethod: ConsoleMethodName = "warn";
  const consoleConfig: ConsoleCaptureConfig = {
    client,
    console: {
      warn(...args: unknown[]) {
        void args;
      }
    },
    levels: [consoleMethod],
    logger: "console",
    timestamp: () => "2026-06-02T10:00:06Z"
  };
  const capture: ConsoleCaptureHandle = installLogBrewConsoleCapture(consoleConfig);
  capture.uninstall();
  const pinoRecord: PinoLogRecord = {
    level: 40,
    time: "2026-06-02T10:00:06.000Z",
    msg: "checkout slow",
    orderId: 42
  };
  void pinoRecord;
  const pinoConfig: PinoDestinationConfig = {
    client,
    logger: "pino",
    timestamp: () => "2026-06-02T10:00:06Z"
  };
  const pinoDestination: PinoDestinationHandle = createLogBrewPinoDestination(pinoConfig);
  pinoDestination.write(JSON.stringify(pinoRecord));
  const winstonInfo: WinstonLogInfo = {
    level: "warn",
    message: "checkout slow",
    orderId: 42
  };
  const winstonConfig: WinstonTransportConfig = {
    client,
    logger: "winston",
    timestamp: () => "2026-06-02T10:00:06Z"
  };
  const winstonTransport: WinstonTransportHandle = createLogBrewWinstonTransport(winstonConfig);
  winstonTransport.write(winstonInfo);
}

void main();
EOF

cat > types-smoke.cts <<'EOF'
import sdk = require("@logbrew/sdk");

const client = sdk.LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app-cjs-types",
  sdkVersion: "0.1.0",
  eventFilter: ((event) => event.type !== "log" || event.attributes.level !== "info") satisfies sdk.EventFilter
});
const transport = sdk.RecordingTransport.alwaysAccept();
const traceContext: sdk.TraceparentContext = sdk.parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
const traceInput: sdk.TraceparentInput = {
  traceId: traceContext.traceId,
  spanId: "b7ad6b7169203331"
};
const traceparent = sdk.createTraceparent(traceInput);
const outgoingHeaders: { traceparent: string } = sdk.createTraceparentHeaders(traceInput);
const traceSpanInput: sdk.TraceparentSpanInput = {
  name: "GET /checkout",
  spanId: "00f067aa0ba902b7",
  status: "ok"
};
const traceSpan: sdk.SpanAttributes = sdk.spanAttributesFromTraceparent(traceparent, traceSpanInput);
if (traceSpan.traceId !== traceContext.traceId) {
  throw new Error("unexpected trace context");
}
if (outgoingHeaders.traceparent !== "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
  throw new Error("unexpected traceparent carrier");
}
const productAction: sdk.ProductActionInput = {
  name: "checkout.submit",
  status: "running",
  sessionId: "sess_123",
  traceId: traceContext.traceId,
  routeTemplate: "/checkout/:step",
  funnel: "checkout",
  step: "submit",
  metadata: { service: "checkout" }
};
const networkMilestone: sdk.NetworkMilestoneInput = {
  routeTemplate: "/payments/:id",
  method: "POST",
  statusCode: 202,
  durationMs: 94,
  sessionId: "sess_123",
  traceId: traceContext.traceId,
  metadata: { service: "checkout" }
};
const timelineOptions: sdk.TimelineAttributesOptions = {
  metadata: { region: "global" }
};
const productTimelineAction: sdk.ActionAttributes = sdk.createProductActionAttributes(productAction, timelineOptions);
const networkTimelineAction: sdk.ActionAttributes = sdk.createNetworkMilestoneAttributes(networkMilestone, timelineOptions);
if (productTimelineAction.metadata?.routeTemplate !== "/checkout/:step") {
  throw new Error("unexpected product timeline route template");
}
if (networkTimelineAction.metadata?.method !== "POST") {
  throw new Error("unexpected network timeline method");
}
const metric: sdk.MetricAttributes = {
  name: "checkout.requests",
  kind: "counter",
  value: 42,
  unit: "{request}",
  temporality: "delta"
};
client.metric("evt_metric_001", "2026-06-02T10:00:06Z", metric);
const consoleLevel: sdk.ConsoleMethodName = "error";
const capture = sdk.installLogBrewConsoleCapture({
  client,
  console: {
    error(...args: unknown[]) {
      void args;
    }
  },
  levels: [consoleLevel],
  logger: "console"
});
capture.uninstall();
const pinoRecord: sdk.PinoLogRecord = {
  level: 50,
  msg: "checkout failed"
};
const pinoDestination: sdk.PinoDestinationHandle = sdk.createLogBrewPinoDestination({
  client,
  logger: "pino"
});
pinoDestination.write(JSON.stringify(pinoRecord));
const winstonInfo: sdk.WinstonLogInfo = {
  level: "error",
  message: "checkout failed"
};
const winstonTransport: sdk.WinstonTransportHandle = sdk.createLogBrewWinstonTransport({
  client,
  logger: "winston"
});
winstonTransport.write(winstonInfo);
void client.flush(transport);
EOF

run_package_manager_script "$package_manager" smoke-types >/dev/null

case "$package_manager" in
  npm)
    rm -rf node_modules
    npm ci >/dev/null
    write_package_tree "$package_manager" package-tree-reinstall.json
    write_plain_package_tree "$package_manager" package-tree-plain-reinstall.txt
    write_plain_package_list "$package_manager" package-list-plain-reinstall.txt
    write_package_list "$package_manager" package-list-reinstall.json
    ;;
  pnpm)
    rm -rf node_modules
    pnpm install --frozen-lockfile >/dev/null
    write_package_tree "$package_manager" package-tree-reinstall.json
    write_plain_package_tree "$package_manager" package-tree-plain-reinstall.txt
    write_plain_package_list "$package_manager" package-list-plain-reinstall.txt
    write_package_list "$package_manager" package-list-reinstall.json
    ;;
esac

assert_installed_package_surface package-tree-reinstall.json
assert_plain_package_tree "$package_manager" package-tree-plain-reinstall.txt
assert_plain_package_list "$package_manager" package-list-plain-reinstall.txt
assert_package_list "$package_manager" package-list-reinstall.json
write_dependency_explanation "$package_manager" dependency-explanation-reinstall.txt
assert_dependency_explanation "$package_manager" dependency-explanation-reinstall.txt
run_package_manager_script "$package_manager" smoke-types >/dev/null

cat > installed-user.test.mjs <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import {
  createTraceparent,
  createLogBrewPinoDestination,
  createLogBrewWinstonTransport,
  installLogBrewConsoleCapture,
  LogBrewClient,
  logAttributesFromConsoleArgs,
  logAttributesFromPinoRecord,
  logAttributesFromWinstonInfo,
  parseTraceparent,
  RecordingTransport,
  spanAttributesFromTraceparent
} from "@logbrew/sdk";
import pino from "pino";
import winston from "winston";

test("installed client preview contains release event", () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "smoke-app-test",
    sdkVersion: "0.1.0"
  });

  client.release("evt_release_test", "2026-06-02T10:00:00Z", {
    version: "1.2.3"
  });

  const payload = client.previewJson();
  assert.match(payload, /"type": "release"/);
});

test("installed traceparent helpers continue W3C trace context", () => {
  const traceparent = "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01";
  const context = parseTraceparent(traceparent);
  const span = spanAttributesFromTraceparent(traceparent, {
    name: "POST /checkout",
    spanId: "b7ad6b7169203331",
    status: "ok",
    durationMs: 18.4,
    metadata: { service: "checkout", ignored: { nested: true } }
  });

  assert.deepEqual(context, {
    version: "00",
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    parentSpanId: "00f067aa0ba902b7",
    traceFlags: "01",
    sampled: true
  });
  assert.equal(
    createTraceparent({ traceId: context.traceId, spanId: span.spanId, traceFlags: "00" }),
    "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-00"
  );
  assert.equal(span.traceId, context.traceId);
  assert.equal(span.parentSpanId, context.parentSpanId);
  assert.equal(span.metadata.service, "checkout");
  assert.equal(span.metadata.ignored, undefined);
  assert.throws(
    () => parseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"),
    /traceparent traceId must not be all zeros/
  );
});

test("installed console capture preserves output and sends log records", async () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "smoke-app-console",
    sdkVersion: "0.1.0"
  });
  const transport = RecordingTransport.alwaysAccept();
  const calls = [];
  const targetConsole = {
    warn(...args) {
      calls.push(["warn", args]);
    },
    error(...args) {
      calls.push(["error", args]);
    }
  };
  const attributes = logAttributesFromConsoleArgs("error", ["checkout failed", new Error("boom")], {
    logger: "console"
  });
  assert.equal(attributes.level, "error");
  assert.equal(attributes.metadata.errorName, "Error");
  assert.equal(attributes.metadata.errorStack, undefined);

  const capture = installLogBrewConsoleCapture({
    client,
    console: targetConsole,
    eventIdPrefix: "installed_console",
    levels: ["warn", "error"],
    logger: "console",
    metadata: { service: "checkout" },
    timestamp: () => "2026-06-02T10:00:06Z",
    transport
  });

  targetConsole.warn("cart queued", { orderId: 42 });
  targetConsole.error("checkout failed", new Error("boom"));
  await capture.flush();
  capture.uninstall();
  targetConsole.warn("after uninstall");

  assert.deepEqual(calls.map(([level]) => level), ["warn", "error", "warn"]);
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(
    body.events.map((event) => event.attributes.level),
    ["warning", "error"]
  );
  assert.equal(body.events[0].attributes.metadata.service, "checkout");
  assert.equal(body.events[1].attributes.metadata.errorName, "Error");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});

test("installed Pino destination captures real Pino records", async () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "smoke-app-pino",
    sdkVersion: "0.1.0"
  });
  const transport = RecordingTransport.alwaysAccept();
  const errors = [];
  const destination = createLogBrewPinoDestination({
    client,
    eventIdPrefix: "installed_pino",
    logger: "pino",
    metadata: { service: "checkout" },
    transport,
    onError(error) {
      errors.push(error);
    }
  });
  const attributes = logAttributesFromPinoRecord({
    level: 40,
    msg: "checkout slow",
    orderId: 42,
    err: {
      type: "TypeError",
      message: "database unavailable",
      stack: "hidden stack"
    }
  }, {
    logger: "pino"
  });
  assert.equal(attributes.level, "warning");
  assert.equal(attributes.metadata.errorName, "TypeError");
  assert.equal(attributes.metadata.errorStack, undefined);

  const logger = pino({
    base: { service: "checkout" },
    timestamp: () => ',"time":"2026-06-02T10:00:06.000Z"'
  }, destination);
  logger.warn({ orderId: 42 }, "checkout slow");
  logger.error(new Error("payment failed"), "checkout failed");
  destination.write("not json\n");

  assert.equal(errors.length, 1);
  assert.equal(client.pendingEvents(), 2);
  await destination.flush();
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(body.events.map((event) => event.id), ["installed_pino_1", "installed_pino_2"]);
  assert.deepEqual(body.events.map((event) => event.attributes.level), ["warning", "error"]);
  assert.equal(body.events[0].timestamp, "2026-06-02T10:00:06.000Z");
  assert.equal(body.events[0].attributes.message, "checkout slow");
  assert.equal(body.events[0].attributes.logger, "pino");
  assert.equal(body.events[0].attributes.metadata.service, "checkout");
  assert.equal(body.events[0].attributes.metadata["context.orderId"], 42);
  assert.equal(body.events[0].attributes.metadata["context.pid"], undefined);
  assert.equal(body.events[1].attributes.metadata.errorName, "Error");
  assert.equal(body.events[1].attributes.metadata.errorMessage, "payment failed");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});

test("installed Winston transport captures real Winston records", async () => {
  const client = LogBrewClient.create({
    apiKey: "LOGBREW_API_KEY",
    sdkName: "smoke-app-winston",
    sdkVersion: "0.1.0"
  });
  const transport = RecordingTransport.alwaysAccept();
  const errors = [];
  const logbrewTransport = createLogBrewWinstonTransport({
    client,
    eventIdPrefix: "installed_winston",
    logger: "winston",
    metadata: { service: "checkout" },
    transport,
    onError(error) {
      errors.push(error);
    }
  });
  const attributes = logAttributesFromWinstonInfo({
    level: "warn",
    message: "checkout slow",
    orderId: 42,
    err: {
      name: "TypeError",
      message: "database unavailable",
      stack: "hidden stack"
    }
  }, {
    logger: "winston"
  });
  assert.equal(attributes.level, "warning");
  assert.equal(attributes.metadata.errorName, "TypeError");
  assert.equal(attributes.metadata.errorStack, undefined);

  const logger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp({ format: () => "2026-06-02T10:00:06.000Z" })
    ),
    transports: [logbrewTransport]
  });
  logger.warn("checkout slow", { orderId: 42 });
  logger.error(new Error("payment failed"));
  logbrewTransport.write("not an info object");

  assert.equal(errors.length, 1);
  assert.equal(client.pendingEvents(), 2);
  await logbrewTransport.flush();
  assert.equal(client.pendingEvents(), 0);
  assert.equal(transport.sentBodies.length, 1);

  const body = JSON.parse(transport.lastBody());
  assert.deepEqual(body.events.map((event) => event.id), ["installed_winston_1", "installed_winston_2"]);
  assert.deepEqual(body.events.map((event) => event.attributes.level), ["warning", "error"]);
  assert.equal(body.events[0].timestamp, "2026-06-02T10:00:06.000Z");
  assert.equal(body.events[0].attributes.message, "checkout slow");
  assert.equal(body.events[0].attributes.logger, "winston");
  assert.equal(body.events[0].attributes.metadata.service, "checkout");
  assert.equal(body.events[0].attributes.metadata["context.orderId"], 42);
  assert.equal(body.events[1].attributes.message, "payment failed");
  assert.equal(body.events[1].attributes.metadata.errorName, "Error");
  assert.equal(body.events[1].attributes.metadata.errorMessage, "payment failed");
  assert.equal(body.events[1].attributes.metadata.errorStack, undefined);
});
EOF

run_package_manager_script "$package_manager" smoke-test >/dev/null

cat > readme-example.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "logbrew-js",
  sdkVersion: "0.1.0"
});

client.release("evt_release_001", "2026-06-02T10:00:00Z", {
  version: "1.2.3",
  commit: "abc123def456",
  notes: "Public release marker"
});
client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
  name: "production",
  region: "global"
});
client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
  title: "Checkout timeout",
  level: "error",
  message: "Request timed out after retry budget"
});
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "worker started",
  level: "info",
  logger: "job-runner"
});
client.span("evt_span_001", "2026-06-02T10:00:04Z", {
  name: "GET /health",
  traceId: "trace_001",
  spanId: "span_001",
  status: "ok",
  durationMs: 12.5
});
client.action("evt_action_001", "2026-06-02T10:00:05Z", {
  name: "deploy",
  status: "success"
});

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
const response = await client.shutdown(transport);
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
EOF

run_package_manager_script "$package_manager" smoke-readme > readme-example.stdout.json 2> readme-example.stderr.json
grep -q '"type": "release"' readme-example.stdout.json
grep -q '"type": "environment"' readme-example.stdout.json
grep -q '"type": "issue"' readme-example.stdout.json
grep -q '"type": "log"' readme-example.stdout.json
grep -q '"type": "span"' readme-example.stdout.json
grep -q '"type": "action"' readme-example.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example.stdout.json >/dev/null
grep -q '"events":6' readme-example.stderr.json
grep -q '"ok":true' readme-example.stderr.json

run_package_manager_script "$package_manager" smoke-readme > readme-example-reinstall.stdout.json 2> readme-example-reinstall.stderr.json
grep -q '"type": "release"' readme-example-reinstall.stdout.json
grep -q '"type": "environment"' readme-example-reinstall.stdout.json
grep -q '"type": "issue"' readme-example-reinstall.stdout.json
grep -q '"type": "log"' readme-example-reinstall.stdout.json
grep -q '"type": "span"' readme-example-reinstall.stdout.json
grep -q '"type": "action"' readme-example-reinstall.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example-reinstall.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example-reinstall.stdout.json >/dev/null
grep -q '"events":6' readme-example-reinstall.stderr.json
grep -q '"ok":true' readme-example-reinstall.stderr.json

run_installed_package_example "node_modules/@logbrew/sdk/examples/readme-example.mjs" installed-example-esm
run_installed_package_example "node_modules/@logbrew/sdk/examples/readme-example.cjs" installed-example-cjs
run_installed_package_example "node_modules/@logbrew/sdk/examples/real-user-smoke.mjs" installed-example-real-user-esm
run_installed_package_example "node_modules/@logbrew/sdk/examples/real-user-smoke.cjs" installed-example-real-user-cjs
check_installed_package_launcher_listing installed-example-launcher-list.txt
check_installed_package_launcher_help installed-example-launcher-help.txt
run_installed_package_launcher "readme-example" installed-example-launcher-readme
run_installed_package_launcher "readme-example:cjs" installed-example-launcher-readme-cjs
run_installed_package_launcher "real-user-smoke" installed-example-launcher-real-user
run_installed_package_launcher "" installed-example-launcher-default
run_installed_package_launcher "real-user-smoke:cjs" installed-example-launcher-real-user-cjs
write_installed_package_example_script_listing "$package_manager" installed-example-script-list.txt
run_installed_package_example_list_command "$package_manager" installed-example-list-script.txt
run_installed_package_example_help_command "$package_manager" installed-example-help-script.txt
run_installed_package_example_script "$package_manager" "readme-example" installed-example-default-script
run_installed_package_example_script "$package_manager" "readme-example:esm" installed-example-esm-script
run_installed_package_example_script "$package_manager" "readme-example:cjs" installed-example-cjs-script
run_installed_package_example_script "$package_manager" "real-user-smoke" installed-example-real-user-default-script
run_installed_package_example_script "$package_manager" "real-user-smoke:esm" installed-example-real-user-esm-script
run_installed_package_example_script "$package_manager" "real-user-smoke:cjs" installed-example-real-user-cjs-script
run_installed_package_example "node_modules/@logbrew/sdk/examples/readme-example.mjs" installed-example-esm-reinstall
run_installed_package_example "node_modules/@logbrew/sdk/examples/readme-example.cjs" installed-example-cjs-reinstall
run_installed_package_example "node_modules/@logbrew/sdk/examples/real-user-smoke.mjs" installed-example-real-user-esm-reinstall
run_installed_package_example "node_modules/@logbrew/sdk/examples/real-user-smoke.cjs" installed-example-real-user-cjs-reinstall
check_installed_package_launcher_listing installed-example-launcher-list-reinstall.txt
check_installed_package_launcher_help installed-example-launcher-help-reinstall.txt
run_installed_package_launcher "readme-example" installed-example-launcher-readme-reinstall
run_installed_package_launcher "readme-example:cjs" installed-example-launcher-readme-cjs-reinstall
run_installed_package_launcher "real-user-smoke" installed-example-launcher-real-user-reinstall
run_installed_package_launcher "" installed-example-launcher-default-reinstall
run_installed_package_launcher "real-user-smoke:cjs" installed-example-launcher-real-user-cjs-reinstall
write_installed_package_example_script_listing "$package_manager" installed-example-script-list-reinstall.txt
run_installed_package_example_list_command "$package_manager" installed-example-list-script-reinstall.txt
run_installed_package_example_help_command "$package_manager" installed-example-help-script-reinstall.txt
run_installed_package_example_script "$package_manager" "readme-example" installed-example-default-script-reinstall
run_installed_package_example_script "$package_manager" "readme-example:esm" installed-example-esm-script-reinstall
run_installed_package_example_script "$package_manager" "readme-example:cjs" installed-example-cjs-script-reinstall
run_installed_package_example_script "$package_manager" "real-user-smoke" installed-example-real-user-default-script-reinstall
run_installed_package_example_script "$package_manager" "real-user-smoke:esm" installed-example-real-user-esm-script-reinstall
run_installed_package_example_script "$package_manager" "real-user-smoke:cjs" installed-example-real-user-cjs-script-reinstall

cat > smoke.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_001", "2026-06-02T10:00:00Z", {
  version: "1.2.3",
  commit: "abc123def456",
  notes: "Public release marker"
});
client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
  name: "production",
  region: "global"
});
client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
  title: "Checkout timeout",
  level: "error",
  message: "Request timed out after retry budget"
});
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "worker started",
  level: "info",
  logger: "job-runner"
});
client.span("evt_span_001", "2026-06-02T10:00:04Z", {
  name: "GET /health",
  traceId: "trace_001",
  spanId: "span_001",
  status: "ok",
  durationMs: 12.5
});
client.action("evt_action_001", "2026-06-02T10:00:05Z", {
  name: "deploy",
  status: "success"
});

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
const response = await client.shutdown(transport);
console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
EOF

run_package_manager_script "$package_manager" smoke-esm > smoke.stdout.json 2> smoke.stderr.json
grep -q '"type": "release"' smoke.stdout.json
grep -q '"type": "environment"' smoke.stdout.json
grep -q '"type": "issue"' smoke.stdout.json
grep -q '"type": "log"' smoke.stdout.json
grep -q '"type": "span"' smoke.stdout.json
grep -q '"type": "action"' smoke.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" smoke.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" smoke.stdout.json >/dev/null
grep -q '"events":6' smoke.stderr.json
grep -q '"ok":true' smoke.stderr.json

cat > smoke-require.cjs <<'EOF'
const { LogBrewClient, RecordingTransport } = require("@logbrew/sdk");

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app-cjs",
  sdkVersion: "0.1.0"
});

client.release("evt_release_001", "2026-06-02T10:00:00Z", {
  version: "1.2.3",
  commit: "abc123def456",
  notes: "Public release marker"
});
client.environment("evt_environment_001", "2026-06-02T10:00:01Z", {
  name: "production",
  region: "global"
});
client.issue("evt_issue_001", "2026-06-02T10:00:02Z", {
  title: "Checkout timeout",
  level: "error",
  message: "Request timed out after retry budget"
});
client.log("evt_log_001", "2026-06-02T10:00:03Z", {
  message: "worker started",
  level: "info",
  logger: "job-runner"
});
client.span("evt_span_001", "2026-06-02T10:00:04Z", {
  name: "GET /health",
  traceId: "trace_001",
  spanId: "span_001",
  status: "ok",
  durationMs: 12.5
});
client.action("evt_action_001", "2026-06-02T10:00:05Z", {
  name: "deploy",
  status: "success"
});

console.log(client.previewJson());

const transport = RecordingTransport.alwaysAccept();
client.shutdown(transport).then((response) => {
  console.error(JSON.stringify({ ok: true, status: response.statusCode, attempts: response.attempts, events: 6 }));
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
EOF

run_package_manager_script "$package_manager" smoke-cjs > smoke-require.stdout.json 2> smoke-require.stderr.json
grep -q '"type": "release"' smoke-require.stdout.json
grep -q '"type": "environment"' smoke-require.stdout.json
grep -q '"type": "issue"' smoke-require.stdout.json
grep -q '"type": "log"' smoke-require.stdout.json
grep -q '"type": "span"' smoke-require.stdout.json
grep -q '"type": "action"' smoke-require.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" smoke-require.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" smoke-require.stdout.json >/dev/null
grep -q '"events":6' smoke-require.stderr.json
grep -q '"ok":true' smoke-require.stderr.json

cat > unauth.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_unauth", "2026-06-02T10:00:00Z", {
  version: "1.2.3"
});

try {
  await client.flush(new RecordingTransport([{ statusCode: 401 }]));
  console.error("expected unauthenticated error");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    code: error.code,
    message: error.message,
    pending: client.pendingEvents()
  }));
}
EOF

node unauth.mjs > unauth.stdout.json
grep -q '"ok":true' unauth.stdout.json
grep -q '"code":"unauthenticated"' unauth.stdout.json
grep -q '"message":"transport rejected the API key"' unauth.stdout.json
grep -q '"pending":1' unauth.stdout.json

cat > retry.mjs <<'EOF'
import { LogBrewClient, RecordingTransport, TransportError } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_retry", "2026-06-02T10:00:00Z", {
  version: "1.2.3"
});

const response = await client.flush(new RecordingTransport([
  TransportError.network("temporary outage"),
  { statusCode: 202 }
]));

console.log(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  pending: client.pendingEvents()
}));
EOF

node retry.mjs > retry.stdout.json
grep -q '"ok":true' retry.stdout.json
grep -q '"status":202' retry.stdout.json
grep -q '"attempts":2' retry.stdout.json
grep -q '"pending":0' retry.stdout.json

cat > shutdown.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_shutdown", "2026-06-02T10:00:00Z", {
  version: "1.2.3"
});

await client.shutdown(RecordingTransport.alwaysAccept());

try {
  client.log("evt_log_shutdown", "2026-06-02T10:00:01Z", {
    message: "should fail",
    level: "info"
  });
  console.error("expected shutdown error");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    code: error.code,
    message: error.message,
    pending: client.pendingEvents()
  }));
}
EOF

node shutdown.mjs > shutdown.stdout.json
grep -q '"ok":true' shutdown.stdout.json
grep -q '"code":"shutdown_error"' shutdown.stdout.json
grep -q '"message":"client is already shut down"' shutdown.stdout.json
grep -q '"pending":0' shutdown.stdout.json

cat > empty-flush.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

const response = await client.flush(RecordingTransport.alwaysAccept());
console.log(JSON.stringify({
  ok: true,
  status: response.statusCode,
  attempts: response.attempts,
  pending: client.pendingEvents()
}));
EOF

node empty-flush.mjs > empty-flush.stdout.json
grep -q '"ok":true' empty-flush.stdout.json
grep -q '"status":204' empty-flush.stdout.json
grep -q '"attempts":0' empty-flush.stdout.json
grep -q '"pending":0' empty-flush.stdout.json

cat > validation.mjs <<'EOF'
import { LogBrewClient } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

try {
  client.log("evt_log_invalid", "2026-06-02T10:00:03", {
    message: "should fail",
    level: "info"
  });
  console.error("expected validation error");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    code: error.code,
    message: error.message,
    pending: client.pendingEvents()
  }));
}
EOF

node validation.mjs > validation.stdout.json
grep -q '"ok":true' validation.stdout.json
grep -q '"code":"validation_error"' validation.stdout.json
grep -q '"message":"timestamp must include a timezone offset: 2026-06-02T10:00:03"' validation.stdout.json
grep -q '"pending":0' validation.stdout.json

cat > retry-budget.mjs <<'EOF'
import { LogBrewClient, RecordingTransport, TransportError } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_retry_budget", "2026-06-02T10:00:00Z", {
  version: "1.2.3"
});

try {
  await client.flush(new RecordingTransport([
    TransportError.network("temporary outage"),
    TransportError.network("temporary outage"),
    TransportError.network("temporary outage")
  ]));
  console.error("expected network failure");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    code: error.code,
    message: error.message,
    pending: client.pendingEvents()
  }));
}
EOF

node retry-budget.mjs > retry-budget.stdout.json
grep -q '"ok":true' retry-budget.stdout.json
grep -q '"code":"network_failure"' retry-budget.stdout.json
grep -q '"message":"temporary outage"' retry-budget.stdout.json
grep -q '"pending":1' retry-budget.stdout.json

cat > transport-status.mjs <<'EOF'
import { LogBrewClient, RecordingTransport } from "@logbrew/sdk";

const client = LogBrewClient.create({
  apiKey: "LOGBREW_API_KEY",
  sdkName: "smoke-app",
  sdkVersion: "0.1.0"
});

client.release("evt_release_transport_status", "2026-06-02T10:00:00Z", {
  version: "1.2.3"
});

try {
  await client.flush(new RecordingTransport([{ statusCode: 400 }]));
  console.error("expected transport error");
  process.exit(1);
} catch (error) {
  console.log(JSON.stringify({
    ok: true,
    code: error.code,
    message: error.message,
    pending: client.pendingEvents()
  }));
}
EOF

node transport-status.mjs > transport-status.stdout.json
grep -q '"ok":true' transport-status.stdout.json
grep -q '"code":"transport_error"' transport-status.stdout.json
grep -q '"message":"unexpected transport status 400"' transport-status.stdout.json
grep -q '"pending":1' transport-status.stdout.json
}

run_smoke_for_package_manager npm
run_smoke_for_package_manager pnpm
