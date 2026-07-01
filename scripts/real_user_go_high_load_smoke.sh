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
import json
import os
import zipfile

repo = Path(os.environ["LOGBREW_REPO_ROOT"]) / "go/logbrew"
proxy = Path(os.environ["LOGBREW_GO_PROXY_DIR"])
module_path = "github.com/LogBrewCo/sdk/go/logbrew"
version = "v0.1.0"


def escape_path(path: str) -> str:
    escaped: list[str] = []
    for char in path:
        escaped.append("!" + char.lower() if "A" <= char <= "Z" else char)
    return "".join(escaped)


version_dir = proxy / escape_path(module_path) / "@v"
version_dir.mkdir(parents=True, exist_ok=True)
(version_dir / "list").write_text(version + "\n")
(version_dir / f"{version}.info").write_text(
    json.dumps({"Version": version, "Time": "2026-06-03T00:00:00Z"})
)
(version_dir / f"{version}.mod").write_text((repo / "go.mod").read_text())

zip_prefix = f"{module_path}@{version}/"
with zipfile.ZipFile(version_dir / f"{version}.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in repo.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            archive.write(path, zip_prefix + path.relative_to(repo).as_posix())
PY

app_dir="$tmp_dir/go-high-load-app"
mkdir -p "$app_dir"
cd "$app_dir"
go mod init logbrew-go-high-load-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod
go get github.com/LogBrewCo/sdk/go/logbrew@none >/dev/null
if grep -q 'github.com/LogBrewCo/sdk/go/logbrew' go.mod; then
	echo "expected go get @none to remove LogBrew module requirement" >&2
	exit 1
fi
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null

cat > high_load_test.go <<'GO'
package highload

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

const (
	apiKey         = "lbw_ingest_go_high_load_fake"
	highVolumeLogs = 1500
	maxQueueSize   = 1000
	traceID        = "4bf92f3577b34da6a3ce929d0e0e4736"
	parentSpanID   = "00f067aa0ba902b7"
	childSpanID    = "b7ad6b7169203331"
)

func TestInstalledGoHighLoadBoundedQueueRetryFlushAndShutdown(t *testing.T) {
	drops := make([]logbrew.EventDrop, 0)
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:         apiKey,
		SDKName:        "go-high-load-smoke",
		SDKVersion:     "0.1.0",
		MaxRetries:     1,
		MaxQueueSize:   maxQueueSize,
		OnEventDropped: func(drop logbrew.EventDrop) { drops = append(drops, drop) },
	})
	if err != nil {
		t.Fatal(err)
	}

	trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-" + traceID + "-" + parentSpanID + "-01",
		SpanID:      childSpanID,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := logbrew.ContextWithLogBrewTrace(context.Background(), trace)

	must(t, client.Release("evt_go_high_load_release", timestamp(0), logbrew.ReleaseAttributes{Version: "checkout@1.2.3"}))
	must(t, client.Environment("evt_go_high_load_environment", timestamp(1), logbrew.EnvironmentAttributes{Name: "production"}))
	duration := 42.5
	span, err := logbrew.SpanAttributesFromTraceContext(logbrew.TraceContextSpanInput{
		Trace:      trace,
		Name:       "POST /checkout/:cart_id",
		Status:     "ok",
		DurationMs: &duration,
		Metadata: map[string]any{
			"service":       "checkout-api",
			"routeTemplate": "/checkout/:cart_id",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	must(t, client.Span("evt_go_high_load_request_span", timestamp(2), span))
	must(t, client.Action("evt_go_high_load_action", timestamp(3), logbrew.ActionAttributes{
		Name:   "checkout.submit",
		Status: "success",
		Metadata: map[string]any{
			"release":     "checkout@1.2.3",
			"environment": "production",
		},
	}))

	for index := 0; index < highVolumeLogs; index++ {
		level := "info"
		if index%10 == 0 {
			level = "warning"
		}
		must(t, client.Log(eventID(index), timestamp(100+index), logbrew.LogAttributesWithTrace(ctx, logbrew.LogAttributes{
			Message: "checkout queue heartbeat",
			Level:   level,
			Logger:  "checkout.high-load",
			Metadata: map[string]any{
				"release":       "checkout@1.2.3",
				"environment":   "production",
				"routeTemplate": "/checkout/:cart_id",
				"sequence":      index,
				"unsafePayload": map[string]any{"body": "must be dropped"},
			},
		})))
	}

	expectedDrops := 4 + highVolumeLogs - maxQueueSize
	requireEqual(t, maxQueueSize, client.PendingEvents(), "bounded queue size")
	requireEqual(t, expectedDrops, client.DroppedEvents(), "dropped event count")
	requireEqual(t, expectedDrops, len(drops), "drop callback count")
	requireEqual(t, "evt_go_high_load_0996", drops[0].EventID, "first dropped event id")
	requireEqual(t, "log", drops[0].EventType, "first dropped event type")
	requireEqual(t, "queue_overflow", drops[0].Reason, "first dropped event reason")
	requireEqual(t, 1, drops[0].DroppedEvents, "first dropped event count")

	advisoryClient, err := logbrew.NewClient(logbrew.Config{
		APIKey:       apiKey,
		SDKName:      "go-high-load-advisory-smoke",
		SDKVersion:   "0.1.0",
		MaxQueueSize: 1,
		OnEventDropped: func(logbrew.EventDrop) {
			panic("drop callback must not interrupt logging")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	must(t, advisoryClient.Log("evt_go_advisory_001", timestamp(2000), logbrew.LogAttributes{Message: "queued", Level: "info"}))
	must(t, advisoryClient.Log("evt_go_advisory_002", timestamp(2001), logbrew.LogAttributes{Message: "dropped", Level: "info"}))
	requireEqual(t, 1, advisoryClient.PendingEvents(), "advisory queue size")
	requireEqual(t, 1, advisoryClient.DroppedEvents(), "advisory dropped count")

	attempts := 0
	lastBody := ""
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		attempts++
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read fake intake body: %v", err)
		}
		lastBody = string(body)
		if request.Header.Get("authorization") != "Bearer "+apiKey {
			t.Fatalf("unexpected authorization header: %s", request.Header.Get("authorization"))
		}
		if attempts == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: server.URL + "/v1/events",
		Headers:  map[string]string{"x-logbrew-source": "go-high-load-smoke"},
		Client:   server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Flush(transport)
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, http.StatusAccepted, response.StatusCode, "flush status")
	requireEqual(t, 2, response.Attempts, "retry attempts")
	requireEqual(t, 2, attempts, "fake intake request count")
	requireEqual(t, 0, client.PendingEvents(), "pending after flush")
	requireEqual(t, expectedDrops, client.DroppedEvents(), "dropped events after flush")

	var payload struct {
		SDK struct {
			Name string `json:"name"`
		} `json:"sdk"`
		Events []struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(lastBody), &payload); err != nil {
		t.Fatal(err)
	}
	requireEqual(t, "go-high-load-smoke", payload.SDK.Name, "sdk name")
	requireEqual(t, maxQueueSize, len(payload.Events), "flushed event count")
	requireEqual(t, 996, strings.Count(lastBody, `"type": "log"`), "flushed log count")
	requireContains(t, lastBody, "evt_go_high_load_0000")
	requireContains(t, lastBody, "evt_go_high_load_0995")
	requireContains(t, lastBody, `"traceId": "`+traceID+`"`)
	requireContains(t, lastBody, `"release": "checkout@1.2.3"`)
	requireContains(t, lastBody, `"environment": "production"`)
	requireContains(t, lastBody, `"level": "warning"`)
	requireNotContains(t, lastBody, "evt_go_high_load_0996")
	requireNotContains(t, lastBody, apiKey)
	requireNotContains(t, lastBody, "must be dropped")
	requireNotContains(t, lastBody, "authorization")

	shutdownClient, err := logbrew.NewClient(logbrew.Config{
		APIKey:     apiKey,
		SDKName:    "go-high-load-shutdown-smoke",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	must(t, shutdownClient.Log("evt_go_shutdown_001", timestamp(3000), logbrew.LogAttributes{Message: "shutdown flush", Level: "info"}))
	shutdownResponse, err := shutdownClient.Shutdown(logbrew.AlwaysAcceptTransport())
	if err != nil {
		t.Fatal(err)
	}
	requireEqual(t, http.StatusAccepted, shutdownResponse.StatusCode, "shutdown status")
	if err := shutdownClient.Log("evt_go_shutdown_after_001", timestamp(3001), logbrew.LogAttributes{Message: "after shutdown", Level: "info"}); err == nil || !strings.Contains(err.Error(), "shutdown_error") {
		t.Fatalf("expected shutdown_error after shutdown, got %v", err)
	}

	t.Logf("go high-load installed-artifact smoke passed: highVolumeLogs=%d flushedEvents=%d droppedEvents=%d retryAttempts=%d shutdownStatus=%d", highVolumeLogs, len(payload.Events), expectedDrops, response.Attempts, shutdownResponse.StatusCode)
}

func eventID(index int) string {
	return "evt_go_high_load_" + leftPad4(index)
}

func leftPad4(value int) string {
	text := "0000" + strconv.Itoa(value)
	return text[len(text)-4:]
}

func timestamp(offset int) string {
	base := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	return base.Add(time.Duration(offset) * time.Second).Format(time.RFC3339)
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func requireEqual[T comparable](t *testing.T, want T, got T, label string) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: got %#v want %#v", label, got, want)
	}
}

func requireContains(t *testing.T, value string, needle string) {
	t.Helper()
	if !strings.Contains(value, needle) {
		t.Fatalf("expected payload to contain %q", needle)
	}
}

func requireNotContains(t *testing.T, value string, needle string) {
	t.Helper()
	if strings.Contains(value, needle) {
		t.Fatalf("expected payload to omit %q", needle)
	}
}
GO

GOFLAGS=-mod=readonly go test ./... -run TestInstalledGoHighLoadBoundedQueueRetryFlushAndShutdown -v > "$tmp_dir/go-high-load.stdout.txt"
grep -q 'go high-load installed-artifact smoke passed' "$tmp_dir/go-high-load.stdout.txt"
grep -q 'PASS' "$tmp_dir/go-high-load.stdout.txt"
cat "$tmp_dir/go-high-load.stdout.txt"
