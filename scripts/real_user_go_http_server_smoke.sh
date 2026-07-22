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

escaped_module="github.com/!log!brew!co/sdk/go/logbrew"
module_zip="$proxy_dir/$escaped_module/@v/v0.1.0.zip"
module_digest="$(shasum -a 256 "$module_zip" | awk '{print $1}')"

app_dir="$tmp_dir/go-http-server-app"
mkdir -p "$app_dir"
cd "$app_dir"
go mod init logbrew-go-http-server-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod
if grep -q '^replace ' go.mod; then
  echo "installed module proof must not use a source replacement" >&2
  exit 1
fi

cat > http_server_test.go <<'GO'
package httpserver

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

const (
	fakeAPIKey       = "lbk_go_http_server_fake"
	expectedTraceID  = "4bf92f3577b34da6a3ce929d0e0e4736"
	expectedParentID = "00f067aa0ba902b7"
	expectedEvents   = 32
)

type installedEvent struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	Attributes map[string]any `json:"attributes"`
}

type installedIntake struct {
	mu       sync.Mutex
	requests int
	events   []installedEvent
}

func (i *installedIntake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/v1/events" {
		http.Error(w, "wrong path", http.StatusNotFound)
		return
	}
	if r.Header.Get("authorization") != "Bearer "+fakeAPIKey || r.Header.Get("content-type") != "application/json" {
		http.Error(w, "wrong auth", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read failed", http.StatusBadRequest)
		return
	}
	var envelope struct {
		Events []installedEvent `json:"events"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || len(envelope.Events) == 0 {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	i.mu.Lock()
	i.requests++
	i.events = append(i.events, envelope.Events...)
	i.mu.Unlock()
	w.WriteHeader(http.StatusAccepted)
}

func (i *installedIntake) snapshot() (int, []installedEvent) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.requests, append([]installedEvent(nil), i.events...)
}

func TestInstalledHTTPServerInstrumentation(t *testing.T) {
	intake := &installedIntake{}
	intakeServer := httptest.NewServer(intake)
	defer intakeServer.Close()
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: intakeServer.URL + "/v1/events",
	})
	if err != nil {
		t.Fatal(err)
	}
	client, err := logbrew.NewAutomaticClient(logbrew.Config{
		APIKey:       fakeAPIKey,
		SDKName:      "go-http-server-smoke",
		SDKVersion:   "0.1.0",
		MaxRetries:   1,
		MaxQueueSize: 128,
	}, logbrew.AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: time.Millisecond,
		RetryMaxDelay:  10 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	var spanCounter atomic.Uint64
	spanIDFactory := func() string {
		return fmt.Sprintf("%016x", spanCounter.Add(1))
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		trace, ok := logbrew.LogBrewTraceFromContext(r.Context())
		if !ok || trace.TraceID != expectedTraceID || trace.ParentSpanID != expectedParentID || !trace.Sampled {
			http.Error(w, "missing trace", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /duplicate", func(w http.ResponseWriter, r *http.Request) {
		trace, ok := logbrew.LogBrewTraceFromContext(r.Context())
		if !ok || trace.TraceID == expectedTraceID || trace.ParentSpanID != "" {
			http.Error(w, "duplicate trusted", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("GET /unavailable", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "opaque upstream response", http.StatusServiceUnavailable)
	})
	mux.HandleFunc("GET /panic", func(http.ResponseWriter, *http.Request) {
		panic("opaque panic value")
	})
	mux.HandleFunc("GET /stream", func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); !ok {
			http.Error(w, "missing flusher", http.StatusInternalServerError)
			return
		}
		if _, ok := w.(http.Hijacker); !ok {
			http.Error(w, "missing hijacker", http.StatusInternalServerError)
			return
		}
		if _, ok := w.(io.ReaderFrom); !ok {
			http.Error(w, "missing reader from", http.StatusInternalServerError)
			return
		}
		if _, err := io.Copy(w, io.LimitReader(strings.NewReader("stream"), 6)); err != nil {
			panic(err)
		}
		w.(http.Flusher).Flush()
	})
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	instrumented, err := logbrew.NewHTTPHandler(mux, logbrew.HTTPHandlerConfig{
		Client:        client,
		EventIDPrefix: "go_http_server_smoke",
		SpanIDFactory: spanIDFactory,
	})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(recoverPanics(instrumented))
	defer server.Close()
	httpClient := &http.Client{Timeout: 3 * time.Second}

	validRequest, err := http.NewRequest(http.MethodPost, server.URL+"/orders/opaque-order?marker=opaque-query", strings.NewReader("opaque request body"))
	if err != nil {
		t.Fatal(err)
	}
	validRequest.Header.Set("authorization", "Bearer opaque-request-auth")
	validRequest.Header.Set("cookie", "session=opaque-cookie")
	validRequest.Header.Set("traceparent", "00-"+expectedTraceID+"-"+expectedParentID+"-01")
	requireResponse(t, httpClient, validRequest, http.StatusNoContent, "")

	duplicateRequest, err := http.NewRequest(http.MethodGet, server.URL+"/duplicate", nil)
	if err != nil {
		t.Fatal(err)
	}
	duplicateRequest.Header.Add("traceparent", "00-"+expectedTraceID+"-"+expectedParentID+"-01")
	duplicateRequest.Header.Add("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	requireResponse(t, httpClient, duplicateRequest, http.StatusAccepted, "")
	requireResponse(t, httpClient, mustRequest(t, server.URL+"/unavailable"), http.StatusServiceUnavailable, "opaque upstream response\n")
	requireResponse(t, httpClient, mustRequest(t, server.URL+"/panic"), http.StatusInternalServerError, "recovered\n")
	requireResponse(t, httpClient, mustRequest(t, server.URL+"/stream"), http.StatusOK, "stream")

	const concurrentRequests = 24
	var wait sync.WaitGroup
	wait.Add(concurrentRequests)
	for index := 0; index < concurrentRequests; index++ {
		go func(index int) {
			defer wait.Done()
			request := mustRequest(t, fmt.Sprintf("%s/items/opaque-%d?marker=value", server.URL, index))
			requireResponse(t, httpClient, request, http.StatusNoContent, "")
		}(index)
	}
	wait.Wait()

	optInMux := http.NewServeMux()
	optInMux.HandleFunc("GET /errors/{id}", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "opaque opted-in response", http.StatusServiceUnavailable)
	})
	optIn, err := logbrew.NewHTTPHandlerWithOptions(optInMux, logbrew.HTTPHandlerConfig{
		Client:        client,
		EventIDPrefix: "go_http_server_opt_in",
		SpanIDFactory: spanIDFactory,
	}, logbrew.WithHTTPServerErrorIssues())
	if err != nil {
		t.Fatal(err)
	}
	optInServer := httptest.NewServer(optIn)
	defer optInServer.Close()
	requireResponse(t, httpClient, mustRequest(t, optInServer.URL+"/errors/opaque-error?marker=value"), http.StatusServiceUnavailable, "opaque opted-in response\n")

	waitFor(t, 10*time.Second, func() bool {
		return client.DeliveryHealth().AcceptedEvents == expectedEvents
	})
	if _, err := client.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	health := client.DeliveryHealth()
	if health.PendingEvents != 0 || health.AcceptedEvents != expectedEvents || health.State != logbrew.DeliveryStateShutdown {
		t.Fatalf("unexpected final health: %#v", health)
	}

	requests, events := intake.snapshot()
	if requests == 0 || len(events) != expectedEvents {
		t.Fatalf("unexpected intake totals: requests=%d events=%d", requests, len(events))
	}
	verifyInstalledEvents(t, events)
	t.Logf("installed HTTP server proof ok: requests=%d events=%d spans=30 issues=2", requests, len(events))
}

func verifyInstalledEvents(t *testing.T, events []installedEvent) {
	t.Helper()
	encoded, err := json.Marshal(events)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"opaque-order", "opaque-query", "opaque request body", "opaque-request-auth",
		"opaque-cookie", "opaque upstream response", "opaque panic value", "opaque opted-in response",
		"opaque-error", "marker=value", "authorization", "cookie", "traceparent", "remoteAddr",
		"requestURI", "host", "localPath",
	} {
		if bytes.Contains(encoded, []byte(forbidden)) {
			t.Fatalf("installed telemetry leaked %q: %s", forbidden, encoded)
		}
	}

	spanIDs := make(map[string]struct{})
	spanCount := 0
	issueCount := 0
	var continued, duplicate, panicSpan, panicIssue, default5xx, optInIssue map[string]any
	for _, event := range events {
		switch event.Type {
		case "span":
			spanCount++
			metadata, ok := event.Attributes["metadata"].(map[string]any)
			if !ok {
				t.Fatalf("span metadata missing or invalid: %#v", event.Attributes)
			}
			route, ok := metadata["routeTemplate"].(string)
			if !ok {
				t.Fatalf("span route missing or invalid: %#v", metadata)
			}
			spanKeys := []string{"durationMs", "metadata", "name", "spanId", "status", "traceId"}
			if route == "/orders/{id}" {
				spanKeys = append(spanKeys, "parentSpanId")
			}
			assertKeys(t, event.Attributes, spanKeys...)
			metadataKeys := []string{"method", "routeTemplate", "sampled", "statusCode"}
			if route == "/panic" {
				metadataKeys = append(metadataKeys, "panic", "panicType")
			}
			assertKeys(t, metadata, metadataKeys...)
			spanID, ok := event.Attributes["spanId"].(string)
			if !ok || spanID == "" {
				t.Fatalf("span id missing or invalid: %#v", event.Attributes)
			}
			if _, exists := spanIDs[spanID]; exists {
				t.Fatalf("duplicate server span id: %s", spanID)
			}
			spanIDs[spanID] = struct{}{}
			switch route {
			case "/orders/{id}":
				continued = event.Attributes
			case "/duplicate":
				duplicate = event.Attributes
			case "/panic":
				panicSpan = event.Attributes
			case "/unavailable":
				default5xx = event.Attributes
			}
		case "issue":
			issueCount++
			assertKeys(t, event.Attributes, "level", "metadata", "title")
			metadata, ok := event.Attributes["metadata"].(map[string]any)
			if !ok {
				t.Fatalf("issue metadata missing or invalid: %#v", event.Attributes)
			}
			switch event.Attributes["title"] {
			case "HTTP server panic":
				assertKeys(t, metadata, "method", "panic", "panicType", "routeTemplate", "sampled", "spanId", "statusCode", "traceId")
				panicIssue = event.Attributes
			case "HTTP server error response":
				assertKeys(t, metadata, "method", "routeTemplate", "sampled", "spanId", "statusCode", "traceId")
				optInIssue = event.Attributes
			default:
				t.Fatalf("unexpected issue title: %#v", event.Attributes)
			}
		default:
			t.Fatalf("unexpected installed event kind: %s", event.Type)
		}
	}
	if spanCount != 30 || issueCount != 2 || len(spanIDs) != spanCount {
		t.Fatalf("unexpected event counts: spans=%d issues=%d uniqueSpans=%d", spanCount, issueCount, len(spanIDs))
	}
	if continued == nil || continued["name"] != "POST /orders/{id}" || continued["traceId"] != expectedTraceID || continued["parentSpanId"] != expectedParentID {
		t.Fatalf("continued request span mismatch: %#v", continued)
	}
	if duplicate == nil || duplicate["parentSpanId"] != nil || duplicate["traceId"] == expectedTraceID {
		t.Fatalf("duplicate traceparent was trusted: %#v", duplicate)
	}
	if default5xx == nil || default5xx["status"] != "error" {
		t.Fatalf("default 5xx span mismatch: %#v", default5xx)
	}
	if panicSpan == nil || panicIssue == nil || panicSpan["status"] != "error" {
		t.Fatalf("panic telemetry missing: %#v %#v", panicSpan, panicIssue)
	}
	panicMetadata := panicIssue["metadata"].(map[string]any)
	if panicMetadata["traceId"] != panicSpan["traceId"] || panicMetadata["spanId"] != panicSpan["spanId"] {
		t.Fatalf("panic issue is not correlated: %#v %#v", panicSpan, panicIssue)
	}
	if optInIssue == nil || optInIssue["metadata"].(map[string]any)["routeTemplate"] != "/errors/{id}" {
		t.Fatalf("opt-in 5xx issue mismatch: %#v", optInIssue)
	}
}

func recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if recover() != nil {
				http.Error(w, "recovered", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func mustRequest(t *testing.T, url string) *http.Request {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func requireResponse(t *testing.T, client *http.Client, request *http.Request, status int, body string) {
	t.Helper()
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status || string(content) != body {
		t.Fatalf("unexpected response: status=%d body=%q", response.StatusCode, content)
	}
}

func waitFor(t *testing.T, timeout time.Duration, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !ready() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for installed delivery")
		}
		time.Sleep(time.Millisecond)
	}
}

func assertKeys(t *testing.T, values map[string]any, allowed ...string) {
	t.Helper()
	set := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		set[key] = struct{}{}
	}
	if len(values) != len(set) {
		t.Fatalf("telemetry field count mismatch: got=%d want=%d values=%#v", len(values), len(set), values)
	}
	for _, key := range allowed {
		if _, ok := values[key]; !ok {
			t.Fatalf("missing telemetry field %q in %#v", key, values)
		}
	}
	for key := range values {
		if _, ok := set[key]; !ok {
			t.Fatalf("unexpected telemetry field %q in %#v", key, values)
		}
	}
}
GO

go test -race -run '^TestInstalledHTTPServerInstrumentation$' -count=1 -v
go list -m all | grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$'
go mod verify

echo "go HTTP server installed-artifact smoke ok: version=v0.1.0 sha256=$module_digest events=32 spans=30 issues=2 processExit=true"
