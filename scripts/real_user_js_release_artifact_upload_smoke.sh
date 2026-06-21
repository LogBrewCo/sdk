#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1

cleanup() {
  if [[ -n "${server_pid:-}" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

dist_dir="$tmp_dir/dist"
mkdir -p "$dist_dir"

sdk_package_version="$(node -p "require('${repo_root}/js/logbrew-js/package.json').version")"

(
  cd "$repo_root/js/logbrew-js"
  npm pack --json --pack-destination "$tmp_dir" > "$tmp_dir/npm-pack.json"
)

package_tgz="$(node -e 'const fs = require("node:fs"); const item = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))[0]; process.stdout.write(item.filename);' "$tmp_dir/npm-pack.json")"
package_path="$tmp_dir/$package_tgz"

(
  cd "$tmp_dir"
  npm init -y >/dev/null
  npm install --ignore-scripts --no-audit --fund=false "$package_path" >/dev/null
)

release_artifacts_cli="$tmp_dir/node_modules/.bin/logbrew-release-artifacts"
test -x "$release_artifacts_cli"

printf 'console.log("compiled app");//# sourceMappingURL=app.js.map\n' > "$dist_dir/app.js"
python3 - "$dist_dir/app.js.map" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "version": 3,
            "file": "app.js",
            "sources": ["src/app.ts"],
            "sourcesContent": ["console.log('source line should stay local')"],
            "names": [],
            "mappings": "AAAA",
        }
    ),
    encoding="utf-8",
)
PY

"$release_artifacts_cli" \
  prepare-js \
  --build-dir "$dist_dir" \
  --strip-sources-content \
  --write \
  > "$tmp_dir/debug-plan.json"

manifest="$tmp_dir/manifest-ready.json"
"$release_artifacts_cli" \
  manifest-js \
  --build-dir "$dist_dir" \
  --release "2026.06.18" \
  --environment "production" \
  --service "checkout-web" \
  --minified-path-prefix "https://cdn.example/assets?cache=placeholder#app" \
  > "$manifest"

port_file="$tmp_dir/fake-intake-port"
state_file="$tmp_dir/fake-intake-state.json"
expected_token="fake-release-artifact-token"

python3 - "$port_file" "$state_file" "$expected_token" <<'PY' &
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

port_file = Path(sys.argv[1])
state_file = Path(sys.argv[2])
expected_token = sys.argv[3]
state = {"events": []}


def write_state() -> None:
    state_file.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        auth = self.headers.get("Authorization", "")
        route = self.path.split("?", 1)[0]
        event = {
            "path": route,
            "authorized": auth == f"Bearer {expected_token}",
            "bodyLength": len(body),
            "containsManifest": b"javascript_source_map_manifest" in body,
            "containsSourceSentinel": b"source line should stay local" in body,
            "containsToken": expected_token.encode("utf-8") in body,
            "containsQueryPlaceholder": b"cache=placeholder" in body,
            "containsTempPath": str(state_file.parent).encode("utf-8") in body,
            "containsSourceMapPart": b'name="source_map_0"' in body,
            "containsMinifiedPart": b'name="minified_source_0"' in body,
        }
        state["events"].append(event)
        write_state()

        if route == "/retry-success":
            if not event["authorized"]:
                self.send_response(401)
            elif sum(1 for seen in state["events"] if seen["path"] == "/retry-success") == 1:
                self.send_response(503)
            else:
                self.send_response(202)
        elif route == "/auth-failure":
            self.send_response(401)
        elif route == "/validation-failure":
            self.send_response(400)
        else:
            self.send_response(404)
        self.end_headers()
        self.wfile.write(b"{}")


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_file.write_text(str(server.server_address[1]), encoding="utf-8")
write_state()
server.serve_forever()
PY
server_pid=$!

for _ in $(seq 1 100); do
  if [[ -s "$port_file" ]]; then
    break
  fi
  sleep 0.05
done

if [[ ! -s "$port_file" ]]; then
  echo "fake release-artifact intake did not start" >&2
  exit 1
fi

endpoint_base="http://127.0.0.1:$(cat "$port_file")"
export LOGBREW_RELEASE_ARTIFACT_TOKEN="$expected_token"

"$release_artifacts_cli" \
  upload-js \
  --build-dir "$dist_dir" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/retry-success?ignored=query#ignored" \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-success.json"

export LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD="wrong-token"
if "$release_artifacts_cli" \
  upload-js \
  --build-dir "$dist_dir" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/auth-failure" \
  --token-env LOGBREW_RELEASE_ARTIFACT_TOKEN_BAD \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-auth-failure.json"; then
  echo "upload verifier unexpectedly accepted auth failure" >&2
  exit 1
fi

if "$release_artifacts_cli" \
  upload-js \
  --build-dir "$dist_dir" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/validation-failure" \
  --retry-delay 0 \
  --max-retries 2 \
  > "$tmp_dir/upload-validation-failure.json"; then
  echo "upload verifier unexpectedly accepted validation failure" >&2
  exit 1
fi

printf 'tampered map\n' >> "$dist_dir/app.js.map"
if "$release_artifacts_cli" \
  upload-js \
  --build-dir "$dist_dir" \
  --manifest "$manifest" \
  --endpoint "$endpoint_base/retry-success" \
  --retry-delay 0 \
  > "$tmp_dir/upload-local-validation-failure.json"; then
  echo "upload verifier unexpectedly accepted a tampered artifact" >&2
  exit 1
fi

python3 - "$tmp_dir/upload-success.json" "$tmp_dir/upload-auth-failure.json" "$tmp_dir/upload-validation-failure.json" "$tmp_dir/upload-local-validation-failure.json" "$state_file" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

success = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
auth_failure = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
validation_failure = json.loads(Path(sys.argv[3]).read_text(encoding="utf-8"))
local_validation_failure = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
state = json.loads(Path(sys.argv[5]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[6]

assert success["status"] == "uploaded"
assert success["retryCount"] == 1
assert [attempt["httpStatus"] for attempt in success["attempts"]] == [503, 202]
assert success["endpoint"].endswith("/retry-success")
assert "ignored=query" not in json.dumps(success)
assert auth_failure["status"] == "auth_failed"
assert len(auth_failure["attempts"]) == 1
assert validation_failure["status"] == "validation_failed"
assert len(validation_failure["attempts"]) == 1
assert local_validation_failure["status"] == "validation_failed"
assert "changed after manifest creation" in json.dumps(local_validation_failure)

events = state["events"]
assert [event["path"] for event in events].count("/retry-success") == 2
assert [event["path"] for event in events].count("/auth-failure") == 1
assert [event["path"] for event in events].count("/validation-failure") == 1
assert all(event["containsManifest"] for event in events)
assert all(event["containsSourceMapPart"] for event in events)
assert all(event["containsMinifiedPart"] for event in events)
assert not any(event["containsSourceSentinel"] for event in events)
assert not any(event["containsToken"] for event in events)
assert not any(event["containsQueryPlaceholder"] for event in events)
assert not any(event["containsTempPath"] for event in events)
assert tmp_dir not in json.dumps(success)
PY

printf 'real-user JavaScript release artifact upload smoke ok (@logbrew/sdk %s)\n' "$sdk_package_version"
