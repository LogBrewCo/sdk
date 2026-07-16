#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
intake_pid=""

cleanup() {
  if [[ -n "$intake_pid" ]]; then
    kill "$intake_pid" 2>/dev/null || true
    wait "$intake_pid" 2>/dev/null || true
  fi
  chmod -R u+w "$tmp_dir" 2>/dev/null || true
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

export GOCACHE="$tmp_dir/go-build-cache"
export GOMODCACHE="$tmp_dir/pkg/mod"
mkdir -p "$GOCACHE" "$GOMODCACHE"

proxy_dir="$tmp_dir/proxy"
mkdir -p "$proxy_dir"
export LOGBREW_GO_PROXY_DIR="$proxy_dir"
export LOGBREW_REPO_ROOT="$repo_root"
python3 - <<'PY'
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo
import json
import os

repo = Path(os.environ["LOGBREW_REPO_ROOT"]) / "go/logbrew"
proxy = Path(os.environ["LOGBREW_GO_PROXY_DIR"])
module_path = "github.com/LogBrewCo/sdk/go/logbrew"
version = "v0.1.0"


def escape_path(path: str) -> str:
    return "".join("!" + char.lower() if "A" <= char <= "Z" else char for char in path)


version_dir = proxy / escape_path(module_path) / "@v"
version_dir.mkdir(parents=True, exist_ok=True)
(version_dir / "list").write_text(version + "\n")
(version_dir / f"{version}.info").write_text(
    json.dumps({"Version": version, "Time": "2026-07-16T00:00:00Z"})
)
(version_dir / f"{version}.mod").write_text((repo / "go.mod").read_text())

zip_prefix = f"{module_path}@{version}/"
with ZipFile(version_dir / f"{version}.zip", "w", compression=ZIP_DEFLATED) as archive:
    for path in sorted(repo.rglob("*")):
        relative = path.relative_to(repo)
        if not path.is_file() or ".git" in path.parts or (relative.parts and relative.parts[0] == "otel"):
            continue
        info = ZipInfo(zip_prefix + relative.as_posix(), (2026, 7, 16, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
PY

app_dir="$tmp_dir/go-persistence-app"
mkdir -p "$app_dir/cmd/writer" "$app_dir/cmd/reader"
cd "$app_dir"
go mod init logbrew-go-persistence-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod

cat > "$tmp_dir/intake.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import base64
import json
import os

log_path = Path(os.environ["LOGBREW_INTAKE_LOG"])
port_path = Path(os.environ["LOGBREW_INTAKE_PORT"])
api_key = os.environ["LOGBREW_FAKE_API_KEY"]
request_count = 0


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global request_count
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        request_count += 1
        record = {
            "path": self.path,
            "authorizationOK": self.headers.get("authorization") == "Bearer " + api_key,
            "body": base64.b64encode(body).decode("ascii"),
        }
        with log_path.open("a", encoding="utf-8") as output:
            output.write(json.dumps(record, separators=(",", ":")) + "\n")
            output.flush()
            os.fsync(output.fileno())
        self.send_response(503 if request_count <= 3 else 202)
        self.end_headers()

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_path.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY

cat > cmd/writer/main.go <<'GO'
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client := persistentClient()
	for index := 0; index < 5; index++ {
		capture(client, fmt.Sprintf("evt_restart_prefix_%02d", index), index)
	}
	preview, err := client.PreviewJSON()
	must(err)
	prefixDigest := sha256.Sum256([]byte(preview))
	if _, err := client.Flush(nil); err == nil {
		panic("expected first process delivery failure")
	}
	for index := 5; index < 7; index++ {
		capture(client, fmt.Sprintf("evt_restart_later_%02d", index), index)
	}
	fmt.Printf("writer hard-exit ready: prefixSHA256=%s queued=%d\n", hex.EncodeToString(prefixDigest[:]), client.PendingEvents())
	_ = os.Stdout.Sync()
	os.Exit(0)
}

func persistentClient() *logbrew.Client {
	key, err := hex.DecodeString(os.Getenv("LOGBREW_PERSISTENCE_KEY_HEX"))
	must(err)
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: os.Getenv("LOGBREW_INTAKE_URL") + "/v1/events",
	})
	must(err)
	client, err := logbrew.NewPersistentAutomaticClient(logbrew.Config{
		APIKey:       os.Getenv("LOGBREW_FAKE_API_KEY"),
		SDKName:      "go-persistence-smoke",
		SDKVersion:   "0.1.0",
		MaxRetries:   2,
		MaxQueueSize: 100,
	}, logbrew.AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 100,
	}, logbrew.PersistentDeliveryConfig{
		Directory:      os.Getenv("LOGBREW_PERSISTENCE_DIRECTORY"),
		EncryptionKey:  key,
		MaxStoredBytes: 4 * 1024 * 1024,
	})
	must(err)
	return client
}

func capture(client *logbrew.Client, id string, offset int) {
	must(client.Log(
		id,
		time.Date(2026, 7, 16, 10, 0, offset, 0, time.UTC).Format(time.RFC3339),
		logbrew.LogAttributes{Message: "encrypted queued event", Level: "info"},
	))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
GO

cat > cmd/reader/main.go <<'GO'
package main

import (
	"encoding/hex"
	"fmt"
	"os"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	key, err := hex.DecodeString(os.Getenv("LOGBREW_PERSISTENCE_KEY_HEX"))
	must(err)
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: os.Getenv("LOGBREW_INTAKE_URL") + "/v1/events",
	})
	must(err)
	client, err := logbrew.NewPersistentAutomaticClient(logbrew.Config{
		APIKey:       os.Getenv("LOGBREW_FAKE_API_KEY"),
		SDKName:      "go-persistence-smoke",
		SDKVersion:   "0.1.0",
		MaxRetries:   2,
		MaxQueueSize: 100,
	}, logbrew.AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 100,
	}, logbrew.PersistentDeliveryConfig{
		Directory:      os.Getenv("LOGBREW_PERSISTENCE_DIRECTORY"),
		EncryptionKey:  key,
		MaxStoredBytes: 4 * 1024 * 1024,
	})
	must(err)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		health := client.DeliveryHealth()
		if health.AcceptedEvents == 5 && health.PendingEvents == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if health := client.DeliveryHealth(); health.AcceptedEvents != 5 || health.PendingEvents != 2 {
		panic(fmt.Sprintf("unexpected recovered prefix health: %#v", health))
	}
	_, err = client.Flush(nil)
	must(err)
	_, err = client.Shutdown(nil)
	must(err)
	if health := client.DeliveryHealth(); health.AcceptedEvents != 7 || health.PendingEvents != 0 || health.State != logbrew.DeliveryStateShutdown {
		panic(fmt.Sprintf("unexpected final health: %#v", health))
	}
	fmt.Println("reader recovery complete: accepted=7 queued=0 shutdown=true")
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
GO

export LOGBREW_INTAKE_LOG="$tmp_dir/intake.jsonl"
export LOGBREW_INTAKE_PORT="$tmp_dir/intake.port"
export LOGBREW_FAKE_API_KEY="lbw_ingest_go_persistence_fake"
python3 "$tmp_dir/intake.py" &
intake_pid=$!
for _ in $(seq 1 100); do
  [[ -s "$LOGBREW_INTAKE_PORT" ]] && break
  sleep 0.01
done
test -s "$LOGBREW_INTAKE_PORT"
intake_port="$(cat "$LOGBREW_INTAKE_PORT")"
export LOGBREW_INTAKE_URL="http://127.0.0.1:$intake_port"
export LOGBREW_PERSISTENCE_DIRECTORY="$tmp_dir/persistent-delivery"
export LOGBREW_PERSISTENCE_KEY_HEX="3131313131313131313131313131313131313131313131313131313131313131"

GOFLAGS=-mod=readonly go run ./cmd/writer > "$tmp_dir/writer.stdout"
grep -Eq '^writer hard-exit ready: prefixSHA256=[0-9a-f]{64} queued=7$' "$tmp_dir/writer.stdout"

if rg -a -n 'LOGBREW_API_KEY|lbw_ingest_go_persistence_fake|evt_restart_|encrypted queued event|127\.0\.0\.1|/v1/events' "$LOGBREW_PERSISTENCE_DIRECTORY" > "$tmp_dir/leaks.txt"; then
  cat "$tmp_dir/leaks.txt" >&2
  exit 1
fi

python3 - "$LOGBREW_PERSISTENCE_DIRECTORY" <<'PY'
from pathlib import Path
import os
import stat
import sys

directory = Path(sys.argv[1])
if stat.S_IMODE(directory.stat().st_mode) != 0o700:
    raise SystemExit("persistence directory is not owner-only")
for path in directory.iterdir():
    if not path.is_file() or path.is_symlink() or stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise SystemExit(f"unsafe persistence file boundary: {path.name}")
PY

GOFLAGS=-mod=readonly go run ./cmd/reader > "$tmp_dir/reader.stdout"
grep -qx 'reader recovery complete: accepted=7 queued=0 shutdown=true' "$tmp_dir/reader.stdout"

python3 - "$LOGBREW_INTAKE_LOG" "$tmp_dir/writer.stdout" <<'PY'
from pathlib import Path
import base64
import hashlib
import json
import re
import sys

records = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
if len(records) != 5:
    raise SystemExit(f"unexpected intake request count: {len(records)}")
if any(record["path"] != "/v1/events" or not record["authorizationOK"] for record in records):
    raise SystemExit("intake path or authorization mismatch")
bodies = [base64.b64decode(record["body"]) for record in records]
if not all(body == bodies[0] for body in bodies[:4]):
    raise SystemExit("failed prefix changed across retry or process restart")
writer_output = Path(sys.argv[2]).read_text()
match = re.search(r"prefixSHA256=([0-9a-f]{64})", writer_output)
if match is None or hashlib.sha256(bodies[3]).hexdigest() != match.group(1):
    raise SystemExit("pre-exit preview digest did not bind recovered retry bytes")

accepted_ids = []
for body in (bodies[3], bodies[4]):
    payload = json.loads(body)
    accepted_ids.extend(event["id"] for event in payload["events"])
expected = [f"evt_restart_prefix_{index:02d}" for index in range(5)] + [
    f"evt_restart_later_{index:02d}" for index in range(5, 7)
]
if accepted_ids != expected or len(set(accepted_ids)) != len(expected):
    raise SystemExit(f"unexpected recovered order or duplicate IDs: {accepted_ids}")
print(
    "installed two-process persistence proof ok: "
    f"requests=5 events=7 prefixSHA256={match.group(1)} orderedUnique=true"
)
PY

artifact="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
artifact_digest="$(shasum -a 256 "$artifact" | awk '{print $1}')"
printf '%s\n' "go encrypted persistence installed-artifact smoke ok: version=v0.1.0 sha256=$artifact_digest processes=2 hardExit=true requests=5 events=7"
