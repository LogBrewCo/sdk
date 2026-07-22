#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
requested_version="${1:-${LOGBREW_GO_MODULE_VERSION:-v0.1.4}}"
module_version="v${requested_version#v}"
module_path="github.com/LogBrewCo/sdk/go/logbrew"
tmp_dir="$(mktemp -d)"
receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"

cleanup() {
  chmod -R u+w "$tmp_dir" 2>/dev/null || true
  rm -rf "$tmp_dir"
}

on_error() {
  local status=$?
  if [[ "$receipt_mode" == "1" ]]; then
    echo "Go release receipt failed" >&2
    exit "$status"
  fi
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

run_receipt_smoke() {
  local bound="$tmp_dir/receipt-artifacts"
  local metadata="$tmp_dir/receipt-metadata.json"
  local extracted="$tmp_dir/receipt-source"
  python3 "$repo_root/scripts/release_artifact_receipt.py" bind \
    --family "go" --output-dir "$bound" --metadata "$metadata" \
    >"$tmp_dir/receipt-bind.out" 2>"$tmp_dir/receipt-bind.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" extract \
    --family "go" --metadata "$metadata" --index 0 --output-dir "$extracted" \
    >"$tmp_dir/receipt-extract.out" 2>"$tmp_dir/receipt-extract.err"
  local package_root
  package_root="$(RECEIPT_MODULE_VERSION="$module_version" python3 - "$extracted" "$module_path" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
expected = "module " + sys.argv[2]
version = os.environ["RECEIPT_MODULE_VERSION"]
matches = [
    path.parent
    for path in root.rglob("go.mod")
    if path.read_text(encoding="utf-8").splitlines()[0] == expected
    and path.parent.name.endswith("@" + version)
]
if len(matches) != 1:
    raise SystemExit(1)
print(matches[0])
PY
)"
  local app="$tmp_dir/receipt-app"
  mkdir -p "$app"
  cd "$app"
  go mod init logbrew.release.receipt >"$tmp_dir/receipt-mod-init.out" 2>"$tmp_dir/receipt-mod-init.err"
  go mod edit -require="${module_path}@${module_version}" -replace="${module_path}=${package_root}"
  cat > main.go <<'GO'
package main

import "github.com/LogBrewCo/sdk/go/logbrew"

func main() {
	client, err := logbrew.NewClient(logbrew.Config{APIKey: "key", SDKName: "receipt", SDKVersion: "0.1.0"})
	if err != nil {
		panic(err)
	}
	if err := client.Log("event", "2026-01-01T00:00:00Z", logbrew.LogAttributes{Message: "ok", Level: "info"}); err != nil {
		panic(err)
	}
	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	if err != nil || response.StatusCode != 202 {
		panic("receipt execution failed")
	}
}
GO
  go run . >"$tmp_dir/receipt-run.out" 2>"$tmp_dir/receipt-run.err"
  python3 "$repo_root/scripts/release_artifact_receipt.py" attest \
    --family "go" --metadata "$metadata"
}

if [[ "$receipt_mode" == "1" ]]; then
  run_receipt_smoke
  exit 0
fi

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
		SDKVersion: "0.1.3",
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
		SDKVersion: "0.1.3",
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

cat > rich_test.go <<'GO'
package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func TestPublicModuleBoundedQueueDrops(t *testing.T) {
	var drops []logbrew.EventDrop
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:       "LOGBREW_API_KEY",
		SDKName:      "go-public-module-rich-smoke",
		SDKVersion:   "0.1.3",
		MaxQueueSize: 1,
		OnEventDropped: func(drop logbrew.EventDrop) {
			drops = append(drops, drop)
		},
	})
	if err != nil {
		t.Fatalf("create bounded client: %v", err)
	}
	if err := client.Log("evt_public_go_kept", "2026-06-02T10:00:07Z", logbrew.LogAttributes{
		Message: "kept event",
		Level:   "info",
	}); err != nil {
		t.Fatalf("capture kept log: %v", err)
	}
	if err := client.Log("evt_public_go_dropped", "2026-06-02T10:00:08Z", logbrew.LogAttributes{
		Message: "dropped event",
		Level:   "info",
	}); err != nil {
		t.Fatalf("capture dropped log: %v", err)
	}
	if client.PendingEvents() != 1 || client.DroppedEvents() != 1 {
		t.Fatalf("unexpected bounded queue state pending=%d dropped=%d", client.PendingEvents(), client.DroppedEvents())
	}
	if len(drops) != 1 ||
		drops[0].EventID != "evt_public_go_dropped" ||
		drops[0].EventType != "log" ||
		drops[0].Reason != "queue_overflow" ||
		drops[0].DroppedEvents != 1 {
		t.Fatalf("unexpected drop advisory: %#v", drops)
	}
	preview, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview bounded queue: %v", err)
	}
	if !strings.Contains(preview, "evt_public_go_kept") || strings.Contains(preview, "evt_public_go_dropped") {
		t.Fatalf("bounded queue preview did not preserve only accepted events: %s", preview)
	}
}

func TestPublicModuleQueuePropagationAndLinks(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-public-module-rich-smoke",
		SDKVersion: "0.1.3",
	})
	if err != nil {
		t.Fatalf("create queue client: %v", err)
	}
	parent, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatalf("create parent trace: %v", err)
	}
	headers := map[string]string{"traceparent": "spoofed"}
	_, err = logbrew.QueueOperationWithLogBrewSpan(
		logbrew.ContextWithLogBrewTrace(context.Background(), parent),
		client,
		"publish checkout",
		func(operationCtx context.Context) (string, error) {
			trace, ok := logbrew.LogBrewTraceFromContext(operationCtx)
			if !ok || trace.SpanID != "b7ad6b7169203345" {
				t.Fatalf("missing active producer trace: %#v", trace)
			}
			return "published", nil
		},
		logbrew.QueueOperationConfig{
			System:        "kafka",
			OperationKind: "publish",
			QueueName:     "checkout-events",
			TaskName:      "checkout.completed",
			TraceparentSetter: func(traceparent string) error {
				headers["traceparent"] = traceparent
				return nil
			},
			Metadata: map[string]any{
				"component":   "checkout",
				"payload":     "private-body",
				"traceparent": "raw-propagation",
			},
			EventIDPrefix: "public_go_queue_publish",
			SpanIDFactory: func() string {
				return "b7ad6b7169203345"
			},
		},
	)
	if err != nil {
		t.Fatalf("queue publish returned error: %v", err)
	}
	if headers["traceparent"] != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203345-01" {
		t.Fatalf("unexpected outgoing traceparent: %q", headers["traceparent"])
	}

	messageCount := 2
	_, err = logbrew.QueueOperationWithLogBrewSpan(
		context.Background(),
		client,
		"process checkout batch",
		func(operationCtx context.Context) (int, error) {
			trace, ok := logbrew.LogBrewTraceFromContext(operationCtx)
			if !ok || trace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || trace.ParentSpanID != "b7ad6b7169203345" {
				t.Fatalf("missing active consumer trace: %#v", trace)
			}
			return 2, nil
		},
		logbrew.QueueOperationConfig{
			System:              "kafka",
			OperationKind:       "process",
			QueueName:           "checkout-events",
			MessageCount:        &messageCount,
			IncomingTraceparent: headers["traceparent"],
			LinkedTraceparents: []string{
				headers["traceparent"],
				"malformed-traceparent",
				"00-55555555555555555555555555555555-6666666666666666-00",
			},
			LinkMetadata: map[string]any{
				"relation":    "batch_item",
				"payload":     "private-link-payload",
				"traceparent": "raw-link-propagation",
			},
			EventIDPrefix: "public_go_queue_process",
			SpanIDFactory: func() string {
				return "b7ad6b7169203346"
			},
		},
	)
	if err != nil {
		t.Fatalf("queue process returned error: %v", err)
	}
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview queue payload: %v", err)
	}
	for _, want := range []string{
		"\"id\": \"public_go_queue_publish_span_b7ad6b7169203345\"",
		"\"id\": \"public_go_queue_process_span_b7ad6b7169203346\"",
		"\"links\": [",
		"\"traceId\": \"4bf92f3577b34da6a3ce929d0e0e4736\"",
		"\"traceId\": \"55555555555555555555555555555555\"",
		"\"messaging.system\": \"kafka\"",
		"\"messaging.batch.message_count\": 2",
		"\"relation\": \"batch_item\"",
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing queue propagation payload %s: %s", want, payload)
		}
	}
	for _, unsafe := range []string{"private-body", "raw-propagation", "private-link-payload", "raw-link-propagation", "malformed-traceparent", "spoofed"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("queue propagation leaked %q: %s", unsafe, payload)
		}
	}
	link, err := logbrew.SpanLinkSummaryFromTraceparent(headers["traceparent"])
	if err != nil {
		t.Fatalf("span link from traceparent: %v", err)
	}
	if link.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" || link.SpanID != "b7ad6b7169203345" || !link.Sampled {
		t.Fatalf("unexpected span link: %#v", link)
	}
	explicit, err := logbrew.NewSpanLinkSummary("11111111111111111111111111111111", "2222222222222222", false)
	if err != nil {
		t.Fatalf("new span link: %v", err)
	}
	if explicit.TraceID != "11111111111111111111111111111111" || explicit.SpanID != "2222222222222222" || explicit.Sampled {
		t.Fatalf("unexpected explicit span link: %#v", explicit)
	}
}

func TestPublicModuleSQLHelpers(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-public-module-rich-smoke",
		SDKVersion: "0.1.3",
	})
	if err != nil {
		t.Fatalf("create SQL client: %v", err)
	}
	parent, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatalf("create parent trace: %v", err)
	}
	ctx := logbrew.ContextWithLogBrewTrace(context.Background(), parent)
	queryer := &fakeSQLQueryer{}
	execer := &fakeSQLExecer{result: fakeSQLResult{rowsAffected: 2}}
	_, err = logbrew.SQLQueryContextWithLogBrewSpan(
		ctx,
		client,
		queryer,
		"lookup checkout order",
		"SELECT * FROM orders WHERE account_ref = ?",
		logbrew.DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "public_go_sql_query",
			Metadata: map[string]any{
				"component":        "checkout",
				"sql":              "SELECT * FROM orders WHERE account_ref = 'opaque-ref-value'",
				"connectionString": "opaque-private-target",
			},
			SpanIDFactory: func() string {
				return "b7ad6b7169203335"
			},
		},
		"opaque-ref-value",
	)
	if err != nil {
		t.Fatalf("query helper returned error: %v", err)
	}
	if queryer.query != "SELECT * FROM orders WHERE account_ref = ?" ||
		len(queryer.args) != 1 ||
		queryer.args[0] != "opaque-ref-value" ||
		queryer.trace.ParentSpanID != parent.SpanID ||
		queryer.trace.SpanID != "b7ad6b7169203335" {
		t.Fatalf("query helper did not preserve app call and trace: %#v", queryer)
	}

	_, err = logbrew.SQLExecContextWithLogBrewSpan(
		ctx,
		client,
		execer,
		"update checkout order",
		"UPDATE orders SET status = ? WHERE id = ?",
		logbrew.DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "public_go_sql_exec",
			Metadata:      map[string]any{"params": []any{"private"}, "component": "checkout"},
			SpanIDFactory: func() string {
				return "b7ad6b7169203336"
			},
		},
		"paid",
		"order-ref-value",
	)
	if err != nil {
		t.Fatalf("exec helper returned error: %v", err)
	}
	if execer.query != "UPDATE orders SET status = ? WHERE id = ?" ||
		len(execer.args) != 2 ||
		execer.args[0] != "paid" ||
		execer.args[1] != "order-ref-value" ||
		execer.trace.ParentSpanID != parent.SpanID ||
		execer.trace.SpanID != "b7ad6b7169203336" {
		t.Fatalf("exec helper did not preserve app call and trace: %#v", execer)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview SQL payload: %v", err)
	}
	for _, want := range []string{
		`"dbOperation": "lookup checkout order"`,
		`"dbOperationKind": "query"`,
		`"dbOperation": "update checkout order"`,
		`"dbOperationKind": "exec"`,
		`"rowCount": 2`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing SQL trace metadata %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{
		"SELECT * FROM orders",
		"UPDATE orders",
		"opaque-ref-value",
		"opaque-private-target",
		"order-ref-value",
		"connectionString",
		"params",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("SQL helper leaked %q: %s", unsafe, payload)
		}
	}
}

type fakeSQLQueryer struct {
	query string
	args  []any
	trace logbrew.TraceContext
}

func (q *fakeSQLQueryer) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.query = query
	q.args = append([]any{}, args...)
	trace, ok := logbrew.LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	q.trace = trace
	return nil, nil
}

type fakeSQLExecer struct {
	query  string
	args   []any
	trace  logbrew.TraceContext
	result sql.Result
}

func (e *fakeSQLExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	e.query = query
	e.args = append([]any{}, args...)
	trace, ok := logbrew.LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	e.trace = trace
	return e.result, nil
}

type fakeSQLResult struct {
	rowsAffected int64
}

func (r fakeSQLResult) LastInsertId() (int64, error) {
	return 0, nil
}

func (r fakeSQLResult) RowsAffected() (int64, error) {
	return r.rowsAffected, nil
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
grep -q "AlwaysAcceptTransport" "$module_dir/README.md"
grep -q "NewHTTPTransport" "$module_dir/README.md"
grep -q "ParseTraceparent" "$module_dir/README.md"
grep -q "MaxQueueSize" "$module_dir/README.md"
grep -q "DroppedEvents" "$module_dir/README.md"
grep -q "TraceparentSetter" "$module_dir/README.md"
grep -q "IncomingTraceparent" "$module_dir/README.md"
grep -q "LinkedTraceparents" "$module_dir/README.md"
grep -q "SQLTransactionWithLogBrewSpan" "$module_dir/README.md"
grep -q "SQLQueryContextWithLogBrewSpan" "$module_dir/README.md"
grep -q "SQLExecContextWithLogBrewSpan" "$module_dir/README.md"

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
run_go_doc go-doc-event-drop.txt "$module_path" EventDrop
run_go_doc go-doc-recording-transport.txt "$module_path" RecordingTransport
run_go_doc go-doc-http-transport.txt "$module_path" NewHTTPTransport
run_go_doc go-doc-parse-traceparent.txt "$module_path" ParseTraceparent
run_go_doc go-doc-span-from-traceparent.txt "$module_path" SpanAttributesFromTraceparent
run_go_doc go-doc-queue-operation.txt "$module_path" QueueOperationWithLogBrewSpan
run_go_doc go-doc-span-link.txt "$module_path" SpanLinkSummary
run_go_doc go-doc-span-link-from-traceparent.txt "$module_path" SpanLinkSummaryFromTraceparent
run_go_doc go-doc-new-span-link.txt "$module_path" NewSpanLinkSummary
run_go_doc go-doc-sql-transaction.txt "$module_path" SQLTransactionWithLogBrewSpan
run_go_doc go-doc-sql-query.txt "$module_path" SQLQueryContextWithLogBrewSpan
run_go_doc go-doc-sql-exec.txt "$module_path" SQLExecContextWithLogBrewSpan

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
