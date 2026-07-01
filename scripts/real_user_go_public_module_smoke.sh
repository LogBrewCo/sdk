#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requested_version="${1:-${LOGBREW_GO_MODULE_VERSION:-v0.1.0}}"
module_version="v${requested_version#v}"
module_path="github.com/LogBrewCo/sdk/go/logbrew"
tmp_dir="$(mktemp -d)"

cleanup() {
  chmod -R u+w "$tmp_dir" 2>/dev/null || true
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  echo "real_user_go_public_module_smoke failed near line $LINENO" >&2
  for diagnostic in \
    "$tmp_dir/go.mod" \
    "$tmp_dir/go.sum" \
    "$tmp_dir/module.json" \
    "$tmp_dir/download.json" \
    "$tmp_dir/go-list-modules.txt" \
    "$tmp_dir/run.stdout.json" \
    "$tmp_dir/run.stderr.json" \
    "$tmp_dir/version-m.txt"; do
    if [[ -f "$diagnostic" ]]; then
      echo "--- ${diagnostic#"$tmp_dir"/} ---" >&2
      sed -n '1,140p' "$diagnostic" >&2
    fi
  done
  exit "$status"
}

trap cleanup EXIT
trap on_error ERR

export GOPATH="$tmp_dir/gopath"
export GOMODCACHE="$tmp_dir/mod"
export GOCACHE="$tmp_dir/cache"
export GOPROXY=https://proxy.golang.org,direct
mkdir -p "$GOPATH" "$GOMODCACHE" "$GOCACHE"

app_dir="$tmp_dir/app"
mkdir -p "$app_dir"
cd "$app_dir"

go mod init logbrew.public.module.smoke >/dev/null
go get github.com/LogBrewCo/sdk/go/logbrew@"$module_version" >/dev/null

cat > main.go <<'GO'
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-public-module-smoke",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_public_go_release", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Public release marker",
	}))
	must(client.Environment("evt_public_go_environment", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
	}))
	must(client.Log("evt_public_go_log", "2026-06-02T10:00:02Z", logbrew.LogAttributes{
		Message: "public Go module smoke",
		Level:   "info",
		Logger:  "go-public-module",
	}))
	duration := 12.5
	must(client.Span("evt_public_go_span", "2026-06-02T10:00:03Z", logbrew.SpanAttributes{
		Name:       "GET /health",
		TraceID:    "trace_public_go",
		SpanID:     "span_public_go",
		Status:     "ok",
		DurationMs: &duration,
	}))
	must(client.Action("evt_public_go_action", "2026-06-02T10:00:04Z", logbrew.ActionAttributes{
		Name:   "go_module_install",
		Status: "success",
	}))

	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	context, err := logbrew.ParseTraceparent(traceparent)
	must(err)
	if !context.Sampled {
		panic("expected sampled traceparent")
	}
	outgoing, err := logbrew.CreateTraceparent(context.TraceID, "b7ad6b7169203331", context.TraceFlags)
	must(err)
	if outgoing != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01" {
		panic("unexpected outgoing traceparent")
	}
	requestSpan, err := logbrew.SpanAttributesFromTraceparent(logbrew.TraceparentSpanInput{
		Traceparent: traceparent,
		Name:        "GET /public-go",
		SpanID:      "b7ad6b7169203331",
		Status:      "ok",
		DurationMs:  &duration,
		Metadata: map[string]any{
			"framework": "net/http",
			"sampled":   context.Sampled,
		},
	})
	must(err)
	must(client.Span("evt_public_go_traceparent_span", "2026-06-02T10:00:05Z", requestSpan))

	preview, err := client.PreviewJSON()
	must(err)
	for _, needle := range []string{
		`"type": "release"`,
		`"type": "environment"`,
		`"type": "log"`,
		`"type": "span"`,
		`"type": "action"`,
		`"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"`,
		`"framework": "net/http"`,
	} {
		if !strings.Contains(preview, needle) {
			panic("preview missing " + needle)
		}
	}

	recording := logbrew.AlwaysAcceptTransport()
	response, err := client.Shutdown(recording)
	must(err)
	if response.StatusCode != 202 || response.Attempts != 1 || len(recording.SentBodies) != 1 {
		panic("unexpected recording transport response")
	}

	httpAttempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		httpAttempts++
		body, err := io.ReadAll(request.Body)
		must(err)
		if request.Method != http.MethodPost {
			panic("unexpected HTTP method")
		}
		if request.Header.Get("authorization") != "Bearer LOGBREW_API_KEY" {
			panic("missing authorization header")
		}
		if request.Header.Get("content-type") != "application/json" {
			panic("missing content type")
		}
		if request.Header.Get("x-logbrew-smoke") != "go-public-module" {
			panic("missing custom header")
		}
		if !strings.Contains(string(body), "evt_public_go_http") {
			panic("missing HTTP event body")
		}
		if httpAttempts == 1 {
			http.Error(w, "retry once", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	httpTransport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: server.URL,
		Headers: map[string]string{"x-logbrew-smoke": "go-public-module"},
	})
	must(err)
	httpClient, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-public-module-http-smoke",
		SDKVersion: "0.1.0",
		MaxRetries: 1,
	})
	must(err)
	must(httpClient.Log("evt_public_go_http", "2026-06-02T10:00:06Z", logbrew.LogAttributes{
		Message: "public Go module HTTP transport smoke",
		Level:   "info",
		Logger:  "go-public-module-http",
	}))
	httpResponse, err := httpClient.Flush(httpTransport)
	must(err)
	if httpResponse.StatusCode != 202 || httpResponse.Attempts != 2 || httpAttempts != 2 {
		panic("unexpected HTTP retry response")
	}

	fmt.Println(preview)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok":           true,
		"status":       response.StatusCode,
		"attempts":     response.Attempts,
		"events":       6,
		"httpAttempts": httpAttempts,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
GO

go mod tidy
grep -q "require github.com/LogBrewCo/sdk/go/logbrew $module_version" go.mod
grep -q "github.com/LogBrewCo/sdk/go/logbrew $module_version" go.sum

go list -m all > "$tmp_dir/go-list-modules.txt"
grep -q "github.com/LogBrewCo/sdk/go/logbrew $module_version" "$tmp_dir/go-list-modules.txt"
go list -m -json github.com/LogBrewCo/sdk/go/logbrew > "$tmp_dir/module.json"
go mod download -json github.com/LogBrewCo/sdk/go/logbrew@"$module_version" > "$tmp_dir/download.json"

python3 - "$tmp_dir/module.json" "$tmp_dir/download.json" "$module_path" "$module_version" <<'PY'
import json
import sys
from pathlib import Path

module_payload = json.loads(Path(sys.argv[1]).read_text())
download_payload = json.loads(Path(sys.argv[2]).read_text())
module_path = sys.argv[3]
module_version = sys.argv[4]

for name, payload in (("go list", module_payload), ("go mod download", download_payload)):
    if payload.get("Path") != module_path:
        raise SystemExit(f"{name}: unexpected path {payload.get('Path')!r}")
    if payload.get("Version") != module_version:
        raise SystemExit(f"{name}: unexpected version {payload.get('Version')!r}")
    if payload.get("Replace"):
        raise SystemExit(f"{name}: module unexpectedly uses replace")
for key in ("Info", "GoMod", "Zip", "Dir", "Sum", "GoModSum"):
    if not download_payload.get(key):
        raise SystemExit(f"go mod download: missing {key}")
PY

module_dir="$(python3 - "$tmp_dir/module.json" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
print(payload["Dir"])
PY
)"
test -f "$module_dir/go.mod"
test -f "$module_dir/README.md"
test -f "$module_dir/logbrew.go"
test -f "$module_dir/examples/readme_example/main.go"
test -f "$module_dir/examples/real_user_smoke/main.go"
grep -q "go get github.com/LogBrewCo/sdk/go/logbrew" "$module_dir/README.md"
grep -q "go doc github.com/LogBrewCo/sdk/go/logbrew NewClient" "$module_dir/README.md"
grep -q "AlwaysAcceptTransport" "$module_dir/README.md"
grep -q "NewHTTPTransport" "$module_dir/README.md"
grep -q "ParseTraceparent" "$module_dir/README.md"

go mod verify > "$tmp_dir/go-mod-verify.txt"
grep -q "all modules verified" "$tmp_dir/go-mod-verify.txt"
go list -deps -json ./... > "$tmp_dir/go-list-deps.json"
grep -q '"ImportPath": "github.com/LogBrewCo/sdk/go/logbrew"' "$tmp_dir/go-list-deps.json"

run_go_doc() {
  local output_name="$1"
  shift
  go doc "$@" > "$tmp_dir/$output_name"
}

run_go_doc go-doc-package.txt "$module_path"
run_go_doc go-doc-new-client.txt "$module_path" NewClient
run_go_doc go-doc-config.txt "$module_path" Config
run_go_doc go-doc-recording-transport.txt "$module_path" RecordingTransport
run_go_doc go-doc-http-transport.txt "$module_path" NewHTTPTransport
run_go_doc go-doc-parse-traceparent.txt "$module_path" ParseTraceparent
run_go_doc go-doc-span-from-traceparent.txt "$module_path" SpanAttributesFromTraceparent

go run . > "$tmp_dir/run.stdout.json" 2> "$tmp_dir/run.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/run.stdout.json" >/dev/null
grep -q '"ok":true' "$tmp_dir/run.stderr.json"
grep -q '"events":6' "$tmp_dir/run.stderr.json"
grep -q '"httpAttempts":2' "$tmp_dir/run.stderr.json"

go test -mod=readonly ./... >/dev/null
go vet -mod=readonly ./...
go build -mod=readonly -o "$tmp_dir/go-public-module-smoke" .
go version -m "$tmp_dir/go-public-module-smoke" > "$tmp_dir/version-m.txt"
grep -q "dep[[:space:]]*${module_path}[[:space:]]*${module_version}" "$tmp_dir/version-m.txt"
go run -mod=readonly . > "$tmp_dir/run-readonly.stdout.json" 2> "$tmp_dir/run-readonly.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/run-readonly.stdout.json" >/dev/null
grep -q '"httpAttempts":2' "$tmp_dir/run-readonly.stderr.json"

printf 'go public module install smoke passed for %s %s\n' "$module_path" "$module_version"
