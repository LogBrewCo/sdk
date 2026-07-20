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
export GOWORK=off
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
    json.dumps({"Version": version, "Time": "2026-07-20T00:00:00Z"})
)
(version_dir / f"{version}.mod").write_text((repo / "go.mod").read_text())

prefix = f"{module_path}@{version}/"
with ZipFile(version_dir / f"{version}.zip", "w", compression=ZIP_DEFLATED) as archive:
    for path in sorted(repo.rglob("*")):
        relative = path.relative_to(repo)
        if not path.is_file() or ".git" in path.parts or (relative.parts and relative.parts[0] == "otel"):
            continue
        info = ZipInfo(prefix + relative.as_posix(), (2026, 7, 20, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, path.read_bytes())
PY

escaped_module="github.com/!log!brew!co/sdk/go/logbrew"
module_zip="$proxy_dir/$escaped_module/@v/v0.1.0.zip"
module_digest="$(shasum -a 256 "$module_zip" | awk '{print $1}')"

app_dir="$tmp_dir/go-http-client-app"
mkdir -p "$app_dir"
cd "$app_dir"
go mod init logbrew-go-http-client-smoke >/dev/null
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew v0.1.0' go.mod
if grep -q '^replace ' go.mod; then
  echo "installed module proof must not use a source replacement" >&2
  exit 1
fi

cat > http_client_test.go <<'GO'
package httpclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

const (
	fakeAPIKey            = "lbk_go_http_client_fake"
	expectedTraceID       = "4bf92f3577b34da6a3ce929d0e0e4736"
	expectedParentID      = "00f067aa0ba902b7"
	expectedTargetRequests = 4
	expectedSpans          = 3
)

type installedEvent struct {
	Type       string         `json:"type"`
	Attributes map[string]any `json:"attributes"`
}

type intakeRecorder struct {
	mu       sync.Mutex
	requests int
	events   []installedEvent
}

func (i *intakeRecorder) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/v1/events" || request.Header.Get("authorization") != "Bearer "+fakeAPIKey {
		http.Error(writer, "rejected", http.StatusUnauthorized)
		return
	}
	var envelope struct {
		Events []installedEvent `json:"events"`
	}
	if err := json.NewDecoder(request.Body).Decode(&envelope); err != nil || len(envelope.Events) == 0 {
		http.Error(writer, "invalid", http.StatusBadRequest)
		return
	}
	i.mu.Lock()
	i.requests++
	i.events = append(i.events, envelope.Events...)
	i.mu.Unlock()
	writer.WriteHeader(http.StatusAccepted)
}

func (i *intakeRecorder) snapshot() (int, []installedEvent) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.requests, append([]installedEvent(nil), i.events...)
}

type targetObservation struct {
	method      string
	traceparent string
	proofHeader string
	body        string
}

type targetRecorder struct {
	mu           sync.Mutex
	observations []targetObservation
}

func (r *targetRecorder) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	body, _ := io.ReadAll(request.Body)
	r.mu.Lock()
	r.observations = append(r.observations, targetObservation{
		method:      request.Method,
		traceparent: request.Header.Get("traceparent"),
		proofHeader: request.Header.Get("x-app-proof"),
		body:        string(body),
	})
	r.mu.Unlock()
	switch request.URL.Path {
	case "/redirect-source":
		writer.Header().Set("location", "/redirect-target?query-marker=query-value")
		writer.WriteHeader(http.StatusFound)
	case "/redirect-target":
		writer.WriteHeader(http.StatusAccepted)
		_, _ = writer.Write([]byte("accepted-response-body"))
	case "/no-parent":
		writer.WriteHeader(http.StatusNoContent)
	case "/failure":
		writer.WriteHeader(http.StatusServiceUnavailable)
		_, _ = writer.Write([]byte("failure-response-body"))
	default:
		http.NotFound(writer, request)
	}
}

func (r *targetRecorder) snapshot() []targetObservation {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]targetObservation(nil), r.observations...)
}

func TestInstalledHTTPClientCorrelation(t *testing.T) {
	intake := &intakeRecorder{}
	intakeServer := httptest.NewServer(intake)
	defer intakeServer.Close()
	target := &targetRecorder{}
	targetServer := httptest.NewServer(target)
	defer targetServer.Close()

	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     fakeAPIKey,
		SDKName:    "go-http-client-smoke",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	var spanCounter atomic.Uint64
	transport, err := logbrew.NewHTTPClientTransport(logbrew.HTTPClientTransportConfig{
		Client:        client,
		Base:          http.DefaultTransport,
		EventIDPrefix: "installed_http",
		SpanIDFactory: func() string { return fmt.Sprintf("%016x", spanCounter.Add(1)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	httpClient := &http.Client{Transport: transport}

	parent, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-" + expectedTraceID + "-" + expectedParentID + "-01",
		SpanID:      "a7ad6b7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	activeContext := logbrew.ContextWithLogBrewTrace(context.Background(), parent)
	redirectRequest, err := http.NewRequestWithContext(activeContext, http.MethodPost, targetServer.URL+"/redirect-source?path-marker=source", strings.NewReader("app-request-body"))
	if err != nil {
		t.Fatal(err)
	}
	redirectRequest.Header.Set("traceparent", "caller-owned")
	redirectRequest.Header.Set("x-app-proof", "app-proof-value")
	redirectResponse, err := httpClient.Do(redirectRequest)
	if err != nil {
		t.Fatal(err)
	}
	redirectBody, err := io.ReadAll(redirectResponse.Body)
	if err != nil || redirectResponse.Body.Close() != nil || redirectResponse.StatusCode != http.StatusAccepted || string(redirectBody) != "accepted-response-body" {
		t.Fatalf("redirect result changed: status=%d body=%q error=%v", redirectResponse.StatusCode, redirectBody, err)
	}
	if redirectRequest.Header.Get("traceparent") != "caller-owned" {
		t.Fatal("caller traceparent changed")
	}

	noParentRequest, err := http.NewRequest(http.MethodGet, targetServer.URL+"/no-parent?path-marker=no-parent", nil)
	if err != nil {
		t.Fatal(err)
	}
	noParentRequest.Header.Set("traceparent", "caller-no-parent")
	noParentResponse, err := httpClient.Do(noParentRequest)
	if err != nil || noParentResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("no-parent result changed: response=%#v error=%v", noParentResponse, err)
	}
	_ = noParentResponse.Body.Close()

	failureRequest, err := http.NewRequestWithContext(activeContext, http.MethodGet, targetServer.URL+"/failure?path-marker=failure", nil)
	if err != nil {
		t.Fatal(err)
	}
	failureResponse, err := httpClient.Do(failureRequest)
	if err != nil || failureResponse.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("failure response changed: response=%#v error=%v", failureResponse, err)
	}
	failureBody, err := io.ReadAll(failureResponse.Body)
	if err != nil || failureResponse.Body.Close() != nil || string(failureBody) != "failure-response-body" {
		t.Fatalf("failure body changed: body=%q error=%v", failureBody, err)
	}

	observations := target.snapshot()
	if len(observations) != expectedTargetRequests {
		t.Fatalf("target request count mismatch: got=%d want=%d", len(observations), expectedTargetRequests)
	}
	if observations[0].method != http.MethodPost || observations[0].body != "app-request-body" || observations[0].proofHeader != "app-proof-value" {
		t.Fatalf("initial request semantics changed: %#v", observations[0])
	}
	if observations[2].traceparent != "caller-no-parent" {
		t.Fatalf("no-parent request was not literal pass-through: %#v", observations[2])
	}
	seenChildren := map[string]struct{}{}
	for _, index := range []int{0, 1, 3} {
		parsed, err := logbrew.ParseTraceparent(observations[index].traceparent)
		if err != nil || parsed.TraceID != expectedTraceID || !parsed.Sampled {
			t.Fatalf("unexpected child propagation at request %d", index)
		}
		seenChildren[parsed.ParentSpanID] = struct{}{}
	}
	if len(seenChildren) != expectedSpans {
		t.Fatalf("actual sends did not receive distinct children: %d", len(seenChildren))
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var preview struct {
		Events []installedEvent `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &preview); err != nil || len(preview.Events) != expectedSpans {
		t.Fatalf("installed span count mismatch")
	}
	for _, event := range preview.Events {
		if event.Type != "span" {
			t.Fatalf("unexpected installed event type: %q", event.Type)
		}
		metadata, ok := event.Attributes["metadata"].(map[string]any)
		if !ok || metadata["source"] != "net/http.client" || metadata["statusCode"] == nil || metadata["host"] != nil {
			t.Fatalf("unexpected installed metadata: %#v", metadata)
		}
	}
	for _, forbidden := range []string{
		"redirect-source", "redirect-target", "no-parent", "failure", "path-marker", "query-marker",
		"app-request-body", "app-proof-value", "accepted-response-body", "failure-response-body",
		"caller-owned", "caller-no-parent", "traceparent", "x-app-proof", "127.0.0.1",
	} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("installed payload leaked %q", forbidden)
		}
	}

	delivery, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: intakeServer.URL + "/v1/events",
		Client:   httpClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	flushResponse, err := client.Flush(delivery)
	if err != nil || flushResponse.StatusCode != http.StatusAccepted || client.PendingEvents() != 0 {
		t.Fatalf("installed flush failed")
	}
	intakeRequests, intakeEvents := intake.snapshot()
	if intakeRequests != 1 || len(intakeEvents) != expectedSpans || len(target.snapshot()) != expectedTargetRequests {
		t.Fatalf("installed intake identity mismatch")
	}
}
GO

go test -race -run '^TestInstalledHTTPClientCorrelation$' -count=1
go list -m all | grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$'
go mod verify

echo "go HTTP client installed-module smoke ok: version=v0.1.0 sha256=$module_digest targetRequests=4 intakeRequests=1 spans=3 processExit=true"
