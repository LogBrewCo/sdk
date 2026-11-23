#!/usr/bin/env bash
#
# test-npm-locked.sh
# Proves that npm_add_logbrew in scripts/npm_locked.sh installs the exact
# tarball or registry release under test, pinned by its sha512: npm ci refuses
# the same version with other contents, and a new build replaces the old one.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# shellcheck source=scripts/npm_locked.sh
source "$root/scripts/npm_locked.sh"
export npm_config_cache="$work/npm-cache" npm_config_update_notifier=false

fail() {
  echo "test-npm-locked: $*" >&2
  exit 1
}

# pack NAME VERSION TEXT [PEER]: writes $work/<TEXT>.tgz, whose index.js exports TEXT.
pack() {
  local dir="$work/src-$3"
  mkdir -p "$dir"
  jq -n --arg n "$1" --arg v "$2" --arg p "${4:-}" \
    '{name: $n, version: $v, main: "index.js", license: "MIT"} + (if $p == "" then {} else {peerDependencies: {($p): "^1.0.0"}} end)' \
    >"$dir/package.json"
  printf 'module.exports = "%s";\n' "$3" >"$dir/index.js"
  (cd "$dir" && npm pack --silent --pack-destination "$work" >/dev/null)
  mv "$work/$(jq -r '.name | sub("@"; "") | gsub("/"; "-")' "$dir/package.json")-$2.tgz" "$work/$3.tgz"
}

sha512() {
  node -e 'process.stdout.write("sha512-" + require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64"))' "$1"
}

expect_export() { # $1: package, $2: text
  local actual
  actual="$(node -p "require('$1')")"
  [[ "$actual" == "$2" ]] || fail "$1 exports $actual, expected $2"
}

new_app() {
  rm -rf "$work/app"
  mkdir -p "$work/app"
  cd "$work/app"
  npm init -y >/dev/null
}

pack @logbrew/sdk 1.0.0 one
pack @logbrew/node 1.0.0 node @logbrew/sdk

new_app
npm_add_logbrew --offline --silent ../one.tgz ../node.tgz
expect_export @logbrew/sdk one
expect_export @logbrew/node node
[[ "$(jq -r '.dependencies["@logbrew/sdk"]' package.json)" == "file:../one.tgz" ]] \
  || fail "package.json does not name the tarball"
[[ "$(jq -r '.packages["node_modules/@logbrew/sdk"].integrity' package-lock.json)" == "$(sha512 "$work/one.tgz")" ]] \
  || fail "package-lock.json does not pin the tarball hash"
npm ls --silent @logbrew/sdk @logbrew/node >/dev/null

pack @logbrew/sdk 1.0.0 two
cp "$work/two.tgz" "$work/one.tgz"
rm -rf node_modules "$npm_config_cache"
if npm ci --offline --silent >/dev/null 2>&1; then
  fail "npm ci installed a tarball whose hash the lockfile does not pin"
fi
npm_add_logbrew --offline --silent ../one.tgz
expect_export @logbrew/sdk two
expect_export @logbrew/node node

pack @logbrew/sdk 1.0.1 three
cp "$work/three.tgz" "$work/served.tgz"
SERVED_INTEGRITY="$(sha512 "$work/three.tgz")"
export SERVED_INTEGRITY
node - "$work/served.tgz" "$work/port" <<'JS' &
const fs = require("node:fs");
const http = require("node:http");
const [tarball, portFile] = process.argv.slice(2);
const server = http.createServer((request, response) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (request.url === "/@logbrew%2fsdk" || request.url === "/@logbrew%2Fsdk") {
    const version = {
      name: "@logbrew/sdk",
      version: "1.0.1",
      main: "index.js",
      license: "MIT",
      dist: { tarball: `${base}/sdk-1.0.1.tgz`, integrity: process.env.SERVED_INTEGRITY },
    };
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: "@logbrew/sdk", "dist-tags": { latest: "1.0.1" }, versions: { "1.0.1": version } }));
  } else if (request.url === "/sdk-1.0.1.tgz") {
    response.end(fs.readFileSync(tarball));
  } else {
    response.statusCode = 404;
    response.end("{}");
  }
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
JS
server_pid=$!
for _ in $(seq 50); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
[[ -s "$work/port" ]] || fail "the test registry did not start"
registry="http://127.0.0.1:$(cat "$work/port")/"

new_app
npm_add_logbrew --silent --registry "$registry" @logbrew/sdk@1.0.1
expect_export @logbrew/sdk three
[[ "$(jq -r '.dependencies["@logbrew/sdk"]' package.json)" == "1.0.1" ]] \
  || fail "package.json does not name the exact release"
[[ "$(jq -r '.packages["node_modules/@logbrew/sdk"].integrity' package-lock.json)" == "$SERVED_INTEGRITY" ]] \
  || fail "package-lock.json does not pin the release hash"

cp "$work/two.tgz" "$work/served.tgz"
rm -rf node_modules "$npm_config_cache"
if npm ci --silent --registry "$registry" >/dev/null 2>&1; then
  fail "npm ci installed a release whose hash the lockfile does not pin"
fi

echo "test-npm-locked: npm_add_logbrew pins tarballs and registry releases by hash"
