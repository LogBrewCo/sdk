#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

cleanup() {
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

app_dir="$tmp_dir/go-delivery-lifecycle-app"
mkdir -p "$app_dir"
cd "$app_dir"
go mod init logbrew-go-delivery-lifecycle-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod

cat > delivery_lifecycle_test.go <<'GO'
package lifecycle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

const apiKey = "lbw_ingest_go_lifecycle_fake"

type intake struct {
	mu                sync.Mutex
	bodies            [][]byte
	paths             []string
	authorizationOK   bool
	active            int
	maxActive         int
	firstStarted      chan struct{}
	releaseFirst      chan struct{}
	firstStartedOnce  sync.Once
}

func newIntake() *intake {
	return &intake{
		authorizationOK: true,
		firstStarted:    make(chan struct{}),
		releaseFirst:    make(chan struct{}),
	}
}

func (i *intake) serveHTTP(response http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		response.WriteHeader(http.StatusBadRequest)
		return
	}

	i.mu.Lock()
	requestIndex := len(i.bodies)
	i.bodies = append(i.bodies, append([]byte(nil), body...))
	i.paths = append(i.paths, request.URL.Path)
	i.authorizationOK = i.authorizationOK && request.Header.Get("authorization") == "Bearer "+apiKey
	i.active++
	if i.active > i.maxActive {
		i.maxActive = i.active
	}
	i.mu.Unlock()

	if requestIndex == 0 {
		i.firstStartedOnce.Do(func() { close(i.firstStarted) })
		<-i.releaseFirst
	}

	i.mu.Lock()
	i.active--
	i.mu.Unlock()
	if requestIndex < 2 {
		response.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	response.WriteHeader(http.StatusAccepted)
}

func (i *intake) snapshot() ([][]byte, []string, bool, int) {
	i.mu.Lock()
	defer i.mu.Unlock()
	bodies := make([][]byte, len(i.bodies))
	for index := range i.bodies {
		bodies[index] = append([]byte(nil), i.bodies[index]...)
	}
	return bodies, append([]string(nil), i.paths...), i.authorizationOK, i.maxActive
}

func TestInstalledAutomaticDeliveryLifecycle(t *testing.T) {
	fakeIntake := newIntake()
	server := httptest.NewServer(http.HandlerFunc(fakeIntake.serveHTTP))
	defer server.Close()

	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: server.URL + "/v1/events",
		Client:   server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	client, err := logbrew.NewAutomaticClient(logbrew.Config{
		APIKey:       apiKey,
		SDKName:      "go-delivery-lifecycle-smoke",
		SDKVersion:   "0.1.0",
		MaxRetries:   1,
		MaxQueueSize: 100,
	}, logbrew.AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  25 * time.Millisecond,
		FlushThreshold: 10,
		RetryBaseDelay: 20 * time.Millisecond,
		RetryMaxDelay:  20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	for index := 0; index < 10; index++ {
		mustCapture(t, client, fmt.Sprintf("evt_owned_%02d", index), index)
	}
	select {
	case <-fakeIntake.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("automatic threshold delivery did not start")
	}
	for index := 10; index < 15; index++ {
		mustCapture(t, client, fmt.Sprintf("evt_later_%02d", index), index)
	}
	close(fakeIntake.releaseFirst)

	waitFor(t, time.Second, func() bool {
		bodies, _, _, _ := fakeIntake.snapshot()
		return len(bodies) == 4 && client.DeliveryHealth().PendingEvents == 0
	})
	bodies, paths, authorizationOK, maxActive := fakeIntake.snapshot()
	if len(bodies) != 4 || !bytes.Equal(bodies[0], bodies[1]) || !bytes.Equal(bodies[1], bodies[2]) {
		t.Fatal("failed prefix retry bytes changed")
	}
	if bytes.Contains(bodies[2], []byte("evt_later_10")) || !bytes.Contains(bodies[3], []byte("evt_later_10")) {
		t.Fatal("later capture was not retained outside the failed prefix")
	}
	if maxActive != 1 {
		t.Fatalf("delivery was not serialized: max active=%d", maxActive)
	}
	if !authorizationOK {
		t.Fatal("fake intake authorization mismatch")
	}
	for _, path := range paths {
		if path != "/v1/events" {
			t.Fatalf("unexpected fake intake path: %s", path)
		}
	}
	assertOrderedUniqueEvents(t, bodies)

	health := client.DeliveryHealth()
	if health.State != logbrew.DeliveryStateRunning || health.LastOutcome != logbrew.DeliveryOutcomeAccepted ||
		health.AcceptedEvents != 15 || health.FailedFlushes != 1 || health.RetrySchedules != 1 ||
		health.PendingEvents != 0 || health.InFlight || health.WakePending {
		t.Fatalf("unexpected health snapshot: %#v", health)
	}
	healthJSON, err := json.Marshal(health)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{apiKey, "evt_owned_00", "queued", server.URL, "authorization", "payload", "message"} {
		if strings.Contains(strings.ToLower(string(healthJSON)), strings.ToLower(forbidden)) {
			t.Fatalf("health leaked forbidden content: %s", healthJSON)
		}
	}

	if _, err := client.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_after_shutdown", timestamp(20), logbrew.LogAttributes{Message: "late", Level: "info"}); err == nil {
		t.Fatal("post-shutdown capture succeeded")
	}
	if client.DeliveryHealth().State != logbrew.DeliveryStateShutdown {
		t.Fatalf("client did not reach shutdown: %#v", client.DeliveryHealth())
	}
	t.Logf("installed Go lifecycle proof passed: requests=%d events=%d retries=%d maxConcurrent=%d", len(bodies), health.AcceptedEvents, health.RetrySchedules, maxActive)
}

func mustCapture(t *testing.T, client *logbrew.Client, id string, offset int) {
	t.Helper()
	if err := client.Log(id, timestamp(offset), logbrew.LogAttributes{Message: "queued", Level: "info"}); err != nil {
		t.Fatal(err)
	}
}

func timestamp(offset int) string {
	return time.Date(2026, 7, 16, 10, 0, offset, 0, time.UTC).Format(time.RFC3339)
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
	t.Fatal("timed out waiting for installed lifecycle proof")
}

func assertOrderedUniqueEvents(t *testing.T, bodies [][]byte) {
	t.Helper()
	seen := make(map[string]struct{})
	ordered := make([]string, 0, 15)
	for _, body := range [][]byte{bodies[2], bodies[3]} {
		var payload struct {
			Events []struct {
				ID string `json:"id"`
			} `json:"events"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Fatal(err)
		}
		for _, event := range payload.Events {
			if _, exists := seen[event.ID]; exists {
				t.Fatalf("duplicate accepted event id: %s", event.ID)
			}
			seen[event.ID] = struct{}{}
			ordered = append(ordered, event.ID)
		}
	}
	if len(ordered) != 15 || ordered[0] != "evt_owned_00" || ordered[9] != "evt_owned_09" || ordered[10] != "evt_later_10" || ordered[14] != "evt_later_14" {
		t.Fatalf("unexpected accepted event order: %#v", ordered)
	}
}
GO

GOFLAGS=-mod=readonly go test -race ./... -run TestInstalledAutomaticDeliveryLifecycle -count=1 -v | tee "$tmp_dir/lifecycle.stdout"
grep -q 'installed Go lifecycle proof passed: requests=4 events=15 retries=1 maxConcurrent=1' "$tmp_dir/lifecycle.stdout"

artifact="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
artifact_digest="$(shasum -a 256 "$artifact" | awk '{print $1}')"
printf '%s\n' "go delivery lifecycle installed-artifact smoke ok: version=v0.1.0 sha256=$artifact_digest requests=4 events=15 retries=1 maxConcurrent=1"
