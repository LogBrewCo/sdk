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

app_dir="$tmp_dir/go-retry-after-app"
mkdir -p "$app_dir/cmd/writer" "$app_dir/cmd/reader"
cd "$app_dir"
go mod init logbrew-go-retry-after-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod

cat > "$tmp_dir/intake.py" <<'PY'
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import base64
import json
import os
import threading
import time

log_path = Path(os.environ["LOGBREW_INTAKE_LOG"])
port_path = Path(os.environ["LOGBREW_INTAKE_PORT"])
api_key = os.environ["LOGBREW_FAKE_API_KEY"]
counts: dict[str, int] = {}
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        scenario = self.headers.get("x-logbrew-scenario", "")
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        received_ns = time.time_ns()
        with lock:
            request_index = counts.get(scenario, 0)
            counts[scenario] = request_index + 1

        status = 202
        retry_after: list[str] = []
        if request_index == 0:
            if scenario == "delta":
                status, retry_after = 503, ["1"]
            elif scenario == "date":
                status, retry_after = 503, [formatdate(time.time() + 2, usegmt=True)]
            elif scenario == "malformed":
                status, retry_after = 503, ["not-a-delay"]
            elif scenario == "capped":
                status, retry_after = 503, ["999999999999999999999999999999"]
            elif scenario == "stale":
                time.sleep(0.2)
                status, retry_after = 503, ["30"]
            elif scenario == "persistence":
                status, retry_after = 503, ["1"]

        record = {
            "scenario": scenario,
            "requestIndex": request_index,
            "timeNs": received_ns,
            "path": self.path,
            "authorizationOK": self.headers.get("authorization") == "Bearer " + api_key,
            "body": base64.b64encode(body).decode("ascii"),
            "status": status,
            "retryAfter": retry_after,
        }
        with lock:
            with log_path.open("a", encoding="utf-8") as output:
                output.write(json.dumps(record, separators=(",", ":")) + "\n")
                output.flush()
                os.fsync(output.fileno())

        self.send_response(status)
        for value in retry_after:
            self.send_header("Retry-After", value)
        self.end_headers()

    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
port_path.write_text(str(server.server_port), encoding="utf-8")
server.serve_forever()
PY

cat > retry_after_test.go <<'GO'
package retryafter

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

type scenarioExpectation struct {
	name          string
	baseDelay     time.Duration
	maxDelay      time.Duration
	wantSource    string
	wantOutcome   string
	wantMinMillis uint64
	wantMaxMillis uint64
	wantInvalid   uint64
}

func TestInstalledRetryAfterDelivery(t *testing.T) {
	tests := []scenarioExpectation{
		{name: "delta", baseDelay: 10 * time.Millisecond, maxDelay: 1500 * time.Millisecond, wantSource: logbrew.DeliveryBackoffSourceServer, wantOutcome: logbrew.DeliveryBackoffOutcomeHonored, wantMinMillis: 1000, wantMaxMillis: 1000},
		{name: "date", baseDelay: 10 * time.Millisecond, maxDelay: 3 * time.Second, wantSource: logbrew.DeliveryBackoffSourceServer, wantOutcome: logbrew.DeliveryBackoffOutcomeHonored, wantMinMillis: 500, wantMaxMillis: 2000},
		{name: "malformed", baseDelay: 100 * time.Millisecond, maxDelay: 100 * time.Millisecond, wantSource: logbrew.DeliveryBackoffSourceClient, wantOutcome: logbrew.DeliveryBackoffOutcomeFallback, wantMinMillis: 50, wantMaxMillis: 100, wantInvalid: 1},
		{name: "capped", baseDelay: 10 * time.Millisecond, maxDelay: 120 * time.Millisecond, wantSource: logbrew.DeliveryBackoffSourceServer, wantOutcome: logbrew.DeliveryBackoffOutcomeClamped, wantMinMillis: 120, wantMaxMillis: 120},
	}
	for _, current := range tests {
		t.Run(current.name, func(t *testing.T) {
			runScenario(t, current)
		})
	}
	t.Run("stale_response", testStaleResponse)
}

func runScenario(t *testing.T, expected scenarioExpectation) {
	client := newClient(t, expected.name, expected.baseDelay, expected.maxDelay)
	capture(t, client, "evt_"+expected.name)
	waitFor(t, 5*time.Second, func() bool { return client.DeliveryHealth().PendingEvents == 0 })
	health := client.DeliveryHealth()
	if health.BackoffSource != expected.wantSource || health.BackoffOutcome != expected.wantOutcome ||
		health.BackoffDelayMillis < expected.wantMinMillis || health.BackoffDelayMillis > expected.wantMaxMillis ||
		health.InvalidServerBackoffs != expected.wantInvalid || health.RetrySchedules != 1 || health.AcceptedEvents != 1 {
		t.Fatalf("unexpected %s health: %#v", expected.name, health)
	}
	assertHealthPrivacy(t, health)
	if _, err := client.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func testStaleResponse(t *testing.T) {
	client := newClient(t, "stale", 10*time.Millisecond, 5*time.Second)
	started := time.Now()
	capture(t, client, "evt_stale")
	waitFor(t, time.Second, func() bool { return client.DeliveryHealth().InFlight })
	if err := client.ResumeDelivery(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 2*time.Second, func() bool { return client.DeliveryHealth().PendingEvents == 0 })
	if elapsed := time.Since(started); elapsed >= 2*time.Second {
		t.Fatalf("stale server delay survived explicit recovery: %v", elapsed)
	}
	health := client.DeliveryHealth()
	if health.BackoffSource != logbrew.DeliveryBackoffSourceNone || health.ServerBackoffs != 0 || health.InvalidServerBackoffs != 0 || health.AcceptedEvents != 1 {
		t.Fatalf("stale response changed health: %#v", health)
	}
	assertHealthPrivacy(t, health)
	if _, err := client.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
}

func newClient(t *testing.T, scenario string, baseDelay, maxDelay time.Duration) *logbrew.Client {
	t.Helper()
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: os.Getenv("LOGBREW_INTAKE_URL") + "/v1/events",
		Headers:  map[string]string{"x-logbrew-scenario": scenario},
	})
	if err != nil {
		t.Fatal(err)
	}
	client, err := logbrew.NewAutomaticClient(logbrew.Config{
		APIKey:       os.Getenv("LOGBREW_FAKE_API_KEY"),
		SDKName:      "go-retry-after-smoke",
		SDKVersion:   "0.1.0",
		MaxRetries:   1,
		MaxQueueSize: 8,
	}, logbrew.AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: baseDelay,
		RetryMaxDelay:  maxDelay,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func capture(t *testing.T, client *logbrew.Client, id string) {
	t.Helper()
	if err := client.Log(id, "2026-07-16T10:00:00Z", logbrew.LogAttributes{Message: "queued", Level: "info"}); err != nil {
		t.Fatal(err)
	}
}

func assertHealthPrivacy(t *testing.T, health logbrew.DeliveryHealth) {
	t.Helper()
	encoded, err := json.Marshal(health)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		os.Getenv("LOGBREW_FAKE_API_KEY"), os.Getenv("LOGBREW_INTAKE_URL"), "evt_", "queued",
		"not-a-delay", "999999999999", "retry-after", "authorization", "endpoint", "header",
		"host", "path", "payload", "message", "error",
	} {
		if strings.Contains(strings.ToLower(string(encoded)), strings.ToLower(forbidden)) {
			t.Fatalf("health leaked forbidden content %q: %s", forbidden, encoded)
		}
	}
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal(fmt.Sprintf("timed out after %v", timeout))
}
GO

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
	for index := 0; index < 3; index++ {
		capture(client, fmt.Sprintf("evt_persistent_prefix_%02d", index), index)
	}
	preview, err := client.PreviewJSON()
	must(err)
	prefixDigest := sha256.Sum256([]byte(preview))
	if _, err := client.Flush(nil); err == nil {
		panic("expected server-directed failure")
	}
	for index := 3; index < 5; index++ {
		capture(client, fmt.Sprintf("evt_persistent_later_%02d", index), index)
	}
	fmt.Printf("writer abrupt-exit ready: prefixSHA256=%s queued=%d\n", hex.EncodeToString(prefixDigest[:]), client.PendingEvents())
	_ = os.Stdout.Sync()
	os.Exit(0)
}

func persistentClient() *logbrew.Client {
	key, err := hex.DecodeString(os.Getenv("LOGBREW_PERSISTENCE_KEY_HEX"))
	must(err)
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: os.Getenv("LOGBREW_INTAKE_URL") + "/v1/events",
		Headers:  map[string]string{"x-logbrew-scenario": "persistence"},
	})
	must(err)
	client, err := logbrew.NewPersistentAutomaticClient(logbrew.Config{
		APIKey: os.Getenv("LOGBREW_FAKE_API_KEY"), SDKName: "go-retry-after-persistence",
		SDKVersion: "0.1.0", MaxRetries: 1, MaxQueueSize: 8,
	}, logbrew.AutomaticDeliveryConfig{
		Transport: transport, FlushInterval: time.Hour, FlushThreshold: 8,
		RetryBaseDelay: 10 * time.Millisecond, RetryMaxDelay: 2 * time.Second,
	}, logbrew.PersistentDeliveryConfig{
		Directory: os.Getenv("LOGBREW_PERSISTENCE_DIRECTORY"), EncryptionKey: key,
		MaxStoredBytes: 4 * 1024 * 1024,
	})
	must(err)
	return client
}

func capture(client *logbrew.Client, id string, offset int) {
	must(client.Log(id, time.Date(2026, 7, 16, 11, 0, offset, 0, time.UTC).Format(time.RFC3339), logbrew.LogAttributes{Message: "encrypted queued event", Level: "info"}))
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
		Headers:  map[string]string{"x-logbrew-scenario": "persistence"},
	})
	must(err)
	client, err := logbrew.NewPersistentAutomaticClient(logbrew.Config{
		APIKey: os.Getenv("LOGBREW_FAKE_API_KEY"), SDKName: "go-retry-after-persistence",
		SDKVersion: "0.1.0", MaxRetries: 1, MaxQueueSize: 8,
	}, logbrew.AutomaticDeliveryConfig{
		Transport: transport, FlushInterval: time.Hour, FlushThreshold: 8,
		RetryBaseDelay: 10 * time.Millisecond, RetryMaxDelay: 2 * time.Second,
	}, logbrew.PersistentDeliveryConfig{
		Directory: os.Getenv("LOGBREW_PERSISTENCE_DIRECTORY"), EncryptionKey: key,
		MaxStoredBytes: 4 * 1024 * 1024,
	})
	must(err)

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		health := client.DeliveryHealth()
		if health.AcceptedEvents == 3 && health.PendingEvents == 2 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if health := client.DeliveryHealth(); health.AcceptedEvents != 3 || health.PendingEvents != 2 {
		panic(fmt.Sprintf("unexpected recovered prefix health: %#v", health))
	}
	_, err = client.Flush(nil)
	must(err)
	_, err = client.Shutdown(nil)
	must(err)
	if health := client.DeliveryHealth(); health.AcceptedEvents != 5 || health.PendingEvents != 0 || health.State != logbrew.DeliveryStateShutdown {
		panic(fmt.Sprintf("unexpected final health: %#v", health))
	}
	fmt.Println("reader recovery complete: accepted=5 queued=0 shutdown=true")
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
GO

export LOGBREW_INTAKE_LOG="$tmp_dir/intake.jsonl"
export LOGBREW_INTAKE_PORT="$tmp_dir/intake.port"
export LOGBREW_FAKE_API_KEY="lbw_ingest_go_retry_after_fake"
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
export LOGBREW_PERSISTENCE_KEY_HEX="3232323232323232323232323232323232323232323232323232323232323232"

GOFLAGS=-mod=readonly go test -race ./... -run TestInstalledRetryAfterDelivery -count=1 -v | tee "$tmp_dir/retry-after.stdout"
grep -q -- '--- PASS: TestInstalledRetryAfterDelivery' "$tmp_dir/retry-after.stdout"

GOFLAGS=-mod=readonly go run ./cmd/writer > "$tmp_dir/writer.stdout"
grep -Eq '^writer abrupt-exit ready: prefixSHA256=[0-9a-f]{64} queued=5$' "$tmp_dir/writer.stdout"

if rg -a -n 'lbw_ingest_go_retry_after_fake|evt_persistent_|encrypted queued event|127\.0\.0\.1|/v1/events|Retry-After' "$LOGBREW_PERSISTENCE_DIRECTORY" > "$tmp_dir/leaks.txt"; then
  cat "$tmp_dir/leaks.txt" >&2
  exit 1
fi

python3 - "$LOGBREW_PERSISTENCE_DIRECTORY" <<'PY'
from pathlib import Path
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
grep -qx 'reader recovery complete: accepted=5 queued=0 shutdown=true' "$tmp_dir/reader.stdout"

python3 - "$LOGBREW_INTAKE_LOG" "$tmp_dir/writer.stdout" <<'PY'
from pathlib import Path
from email.utils import parsedate_to_datetime
import base64
import hashlib
import json
import re
import sys

records = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
groups: dict[str, list[dict]] = {}
for record in records:
    groups.setdefault(record["scenario"], []).append(record)
    if record["path"] != "/v1/events" or not record["authorizationOK"]:
        raise SystemExit("intake path or authorization mismatch")

for scenario in ("delta", "date", "malformed", "capped", "stale"):
    current = groups.get(scenario, [])
    if len(current) != 2:
        raise SystemExit(f"unexpected {scenario} request count: {len(current)}")
    bodies = [base64.b64decode(record["body"]) for record in current]
    if bodies[0] != bodies[1]:
        raise SystemExit(f"{scenario} retry body changed")

if groups["delta"][0]["retryAfter"] != ["1"]:
    raise SystemExit("delta Retry-After proof mismatch")
delta_seconds = (groups["delta"][1]["timeNs"] - groups["delta"][0]["timeNs"]) / 1e9
if not 0.8 <= delta_seconds <= 5.0:
    raise SystemExit(f"delta retry timing mismatch: {delta_seconds}")

date_value = groups["date"][0]["retryAfter"][0]
if parsedate_to_datetime(date_value).tzinfo is None:
    raise SystemExit("date Retry-After was not IMF-fixdate")
date_seconds = (groups["date"][1]["timeNs"] - groups["date"][0]["timeNs"]) / 1e9
if not 0.5 <= date_seconds <= 5.0:
    raise SystemExit(f"date retry timing mismatch: {date_seconds}")

malformed_seconds = (groups["malformed"][1]["timeNs"] - groups["malformed"][0]["timeNs"]) / 1e9
if not 0.04 <= malformed_seconds <= 2.0:
    raise SystemExit(f"malformed fallback timing mismatch: {malformed_seconds}")
capped_seconds = (groups["capped"][1]["timeNs"] - groups["capped"][0]["timeNs"]) / 1e9
if not 0.09 <= capped_seconds <= 2.0:
    raise SystemExit(f"capped retry timing mismatch: {capped_seconds}")
stale_seconds = (groups["stale"][1]["timeNs"] - groups["stale"][0]["timeNs"]) / 1e9
if not 0.15 <= stale_seconds <= 2.0:
    raise SystemExit(f"stale response timing mismatch: {stale_seconds}")

persistence = groups.get("persistence", [])
if len(persistence) != 3:
    raise SystemExit(f"unexpected persistence request count: {len(persistence)}")
persistence_bodies = [base64.b64decode(record["body"]) for record in persistence]
if persistence_bodies[0] != persistence_bodies[1]:
    raise SystemExit("failed persistent prefix changed across abrupt restart")
writer_output = Path(sys.argv[2]).read_text()
match = re.search(r"prefixSHA256=([0-9a-f]{64})", writer_output)
if match is None or hashlib.sha256(persistence_bodies[1]).hexdigest() != match.group(1):
    raise SystemExit("pre-exit digest did not bind recovered retry bytes")

accepted_ids = []
for body in persistence_bodies[1:]:
    payload = json.loads(body)
    accepted_ids.extend(event["id"] for event in payload["events"])
expected_ids = [f"evt_persistent_prefix_{index:02d}" for index in range(3)] + [
    f"evt_persistent_later_{index:02d}" for index in range(3, 5)
]
if accepted_ids != expected_ids or len(set(accepted_ids)) != len(expected_ids):
    raise SystemExit(f"unexpected recovered order or duplicate IDs: {accepted_ids}")
print(
    "installed retry-after proof ok: "
    f"requests={len(records)} scenarios=6 prefixSHA256={match.group(1)} orderedUnique=true"
)
PY

artifact="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
artifact_digest="$(shasum -a 256 "$artifact" | awk '{print $1}')"
printf '%s\n' "go Retry-After installed-artifact smoke ok: version=v0.1.0 sha256=$artifact_digest processes=2 abruptExit=true requests=13"
