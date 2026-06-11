#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

core_pack_json="$tmp_dir/core-pack.json"
svelte_pack_json="$tmp_dir/svelte-pack.json"
(cd "$repo_root/js/logbrew-js" && npm pack --json --pack-destination "$tmp_dir") > "$core_pack_json"
(cd "$repo_root/js/logbrew-svelte" && npm pack --json --pack-destination "$tmp_dir") > "$svelte_pack_json"

core_tgz="$(python3 - "$core_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
svelte_tgz="$(python3 - "$svelte_pack_json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload[0]["filename"])
PY
)"
core_tgz="$tmp_dir/$core_tgz"
svelte_tgz="$tmp_dir/$svelte_tgz"
test -f "$core_tgz"
test -f "$svelte_tgz"

tar -tzf "$svelte_tgz" > "$tmp_dir/svelte-tarball.txt"
grep -q '^package/README.md$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/index.js$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/index.cjs$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/index.d.ts$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/index.d.cts$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/examples/index.mjs$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/examples/package.json$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/examples/readme-example.mjs$' "$tmp_dir/svelte-tarball.txt"
grep -q '^package/examples/real-user-smoke.mjs$' "$tmp_dir/svelte-tarball.txt"
tar -xOf "$svelte_tgz" package/README.md > "$tmp_dir/svelte-readme.md"
grep -q 'npm install @logbrew/sdk @logbrew/svelte svelte' "$tmp_dir/svelte-readme.md"
grep -q 'pnpm add @logbrew/sdk @logbrew/svelte svelte' "$tmp_dir/svelte-readme.md"
grep -q 'LOGBREW_API_KEY' "$tmp_dir/svelte-readme.md"
grep -q 'LOGBREW_CLIENT_KEY' "$tmp_dir/svelte-readme.md"
grep -q 'createTraceparentFetch' "$tmp_dir/svelte-readme.md"
grep -q 'createSvelteTraceparent' "$tmp_dir/svelte-readme.md"
grep -q 'tracePropagationTargets' "$tmp_dir/svelte-readme.md"
grep -q 'setLogBrewContext' "$tmp_dir/svelte-readme.md"
grep -q 'useLogBrew' "$tmp_dir/svelte-readme.md"
grep -q 'captureSvelteError' "$tmp_dir/svelte-readme.md"

app_dir="$tmp_dir/svelte-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
npm init -y >/dev/null
npm pkg set type=module >/dev/null
svelte_version="$(npm view svelte version)"
npm install \
  --save-exact \
  "$core_tgz" \
  "$svelte_tgz" \
  "svelte@$svelte_version" \
  typescript \
  @types/node \
  >/dev/null

grep -q '"@logbrew/sdk": "file:' package.json
grep -q '"@logbrew/svelte": "file:' package.json
grep -q '"svelte":' package.json
grep -q '"@logbrew/svelte"' package-lock.json
grep -q '"@logbrew/sdk"' package-lock.json
npm ls @logbrew/sdk @logbrew/svelte svelte >/dev/null
npm explain @logbrew/svelte > "$tmp_dir/npm-explain-svelte.txt"
grep -q '@logbrew/svelte@0.1.0' "$tmp_dir/npm-explain-svelte.txt"
npm list --depth=0 > "$tmp_dir/npm-list-depth0.txt"
grep -q '@logbrew/svelte@0.1.0' "$tmp_dir/npm-list-depth0.txt"
grep -q "@logbrew/sdk@${sdk_package_version}" "$tmp_dir/npm-list-depth0.txt"
npm list --json --depth=0 > "$tmp_dir/npm-list-depth0.json"
python3 - "$tmp_dir/npm-list-depth0.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
deps = payload.get("dependencies", {})
for name in ("@logbrew/svelte", "@logbrew/sdk", "svelte"):
    if name not in deps:
        raise SystemExit(f"missing npm dependency entry: {name}")
PY

node node_modules/@logbrew/svelte/examples/index.mjs --help > "$tmp_dir/launcher-help.txt"
grep -q 'readme-example' "$tmp_dir/launcher-help.txt"
grep -q 'real-user-smoke' "$tmp_dir/launcher-help.txt"
node node_modules/@logbrew/svelte/examples/index.mjs --list > "$tmp_dir/launcher-list.txt"
grep -q 'readme-example ->' "$tmp_dir/launcher-list.txt"
grep -q 'real-user-smoke ->' "$tmp_dir/launcher-list.txt"

node node_modules/@logbrew/svelte/examples/index.mjs readme-example > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/readme.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/readme.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/readme.stderr.json"
grep -q '"rendered":true' "$tmp_dir/readme.stderr.json"

node node_modules/@logbrew/svelte/examples/index.mjs real-user-smoke > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/smoke.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/smoke.stderr.json"
grep -q '"attempts":2' "$tmp_dir/smoke.stderr.json"
grep -q '"missingContextFailed":true' "$tmp_dir/smoke.stderr.json"
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/smoke.stderr.json"
grep -q '"rendered":true' "$tmp_dir/smoke.stderr.json"

npm --prefix node_modules/@logbrew/svelte/examples --silent run list > "$tmp_dir/npm-helper-list.txt"
grep -q 'real-user-smoke ->' "$tmp_dir/npm-helper-list.txt"
npm --prefix node_modules/@logbrew/svelte/examples --silent run help > "$tmp_dir/npm-helper-help.txt"
grep -q 'npm --prefix node_modules/@logbrew/svelte/examples run real-user-smoke' "$tmp_dir/npm-helper-help.txt"
npm --prefix node_modules/@logbrew/svelte/examples --silent run readme-example > "$tmp_dir/npm-readme.stdout.json" 2> "$tmp_dir/npm-readme.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-readme.stdout.json" >/dev/null
npm --prefix node_modules/@logbrew/svelte/examples --silent run real-user-smoke > "$tmp_dir/npm-smoke.stdout.json" 2> "$tmp_dir/npm-smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/npm-smoke.stdout.json" >/dev/null
grep -q '"propagatedTraceparent":"00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01"' "$tmp_dir/npm-smoke.stderr.json"

cat > consumer.ts <<'EOF'
import { RecordingTransport } from "@logbrew/sdk";
import {
  captureSvelteError,
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createSvelteErrorEvent,
  createSvelteTraceparent,
  createSvelteViewEvent,
  createTraceparentFetch,
  shouldPropagateTraceparent,
  type LogBrewSvelteContext,
  type TracePropagationTarget
} from "@logbrew/svelte";

const client = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "typed-svelte-smoke",
  sdkVersion: "0.1.0"
});
const traceTargets: TracePropagationTarget[] = ["https://api.example.test/", /^\/api\//u];
const tracedFetch = createTraceparentFetch({
  fetchImpl: async (_input: unknown, _init?: unknown): Promise<{ status: number }> => ({ status: 204 }),
  traceparentFactory: () => createSvelteTraceparent({
    randomValues: (length: number) => new Uint8Array(length).fill(7)
  }),
  tracePropagationTargets: traceTargets
});
if (!shouldPropagateTraceparent("https://api.example.test/ping", traceTargets)) {
  throw new Error("expected typed trace target to match");
}
if (shouldPropagateTraceparent("https://api.example.test.evil.test/ping", ["https://api.example.test"])) {
  throw new Error("lookalike origin must not receive traceparent");
}
if (!shouldPropagateTraceparent("https://api.example.test/v1/orders", ["https://api.example.test/v1"])) {
  throw new Error("expected same-origin path prefix to match trace propagation target");
}
if (shouldPropagateTraceparent("https://api.example.test/v10/orders", ["https://api.example.test/v1"])) {
  throw new Error("path prefix must respect segment boundaries");
}
void tracedFetch("/api/typed");
const context: LogBrewSvelteContext = createLogBrewSvelteContext({
  client,
  transport: RecordingTransport.alwaysAccept()
});
const view = createSvelteViewEvent("TypedSvelte", {
  path: "/typed"
});
client.log(view.id, view.timestamp, view.attributes);
const event = createSvelteErrorEvent(new Error("typed failure"), {
  component: "TypedSvelte"
});
void captureSvelteError(new Error(event.attributes.message), context, {
  component: "TypedSvelte"
});
void context.flush();
EOF
cat > tsconfig.json <<'EOF'
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "skipLibCheck": false,
    "noEmit": true
  },
  "include": ["consumer.ts"]
}
EOF
npx tsc --project tsconfig.json

node - <<'NODE'
const {
  createLogBrewSvelteClient,
  createLogBrewSvelteContext,
  createSvelteTraceparent,
  createSvelteViewEvent,
  createTraceparentFetch,
  LOG_BREW_SVELTE_KEY
} = require("@logbrew/svelte");
const { RecordingTransport } = require("@logbrew/sdk");
const client = createLogBrewSvelteClient({
  clientKey: "LOGBREW_CLIENT_KEY",
  sdkName: "cjs-svelte-smoke",
  sdkVersion: "0.1.0"
});
const context = createLogBrewSvelteContext({
  client,
  transport: RecordingTransport.alwaysAccept()
});
const event = createSvelteViewEvent("CommonJS", { path: "/cjs" });
const traceparent = createSvelteTraceparent({
  randomValues: (length) => new Uint8Array(length).fill(1)
});
if (!LOG_BREW_SVELTE_KEY || event.attributes.logger !== "svelte" || context.client !== client || typeof createTraceparentFetch !== "function" || !traceparent.startsWith("00-")) {
  throw new Error("CommonJS Svelte entry failed");
}
NODE

echo "svelte real-user smoke passed with svelte@$svelte_version"
