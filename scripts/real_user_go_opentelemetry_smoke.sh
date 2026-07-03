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

repo_root = Path(os.environ["LOGBREW_REPO_ROOT"])
proxy = Path(os.environ["LOGBREW_GO_PROXY_DIR"])
version = "v0.1.0"


def escape_path(path: str) -> str:
    escaped: list[str] = []
    for char in path:
        escaped.append("!" + char.lower() if "A" <= char <= "Z" else char)
    return "".join(escaped)


def write_module(module_path: str, module_root: Path, *, exclude_otel: bool = False) -> None:
    version_dir = proxy / escape_path(module_path) / "@v"
    version_dir.mkdir(parents=True, exist_ok=True)
    (version_dir / "list").write_text(version + "\n")
    (version_dir / f"{version}.info").write_text(
        json.dumps({"Version": version, "Time": "2026-06-03T00:00:00Z"})
    )
    (version_dir / f"{version}.mod").write_text((module_root / "go.mod").read_text())
    zip_prefix = f"{module_path}@{version}/"
    with zipfile.ZipFile(version_dir / f"{version}.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in module_root.rglob("*"):
            if not path.is_file() or ".git" in path.parts:
                continue
            relative = path.relative_to(module_root)
            if exclude_otel and relative.parts and relative.parts[0] == "otel":
                continue
            archive.write(path, zip_prefix + relative.as_posix())


write_module(
    "github.com/LogBrewCo/sdk/go/logbrew",
    repo_root / "go/logbrew",
    exclude_otel=True,
)
write_module(
    "github.com/LogBrewCo/sdk/go/logbrew/otel",
    repo_root / "go/logbrew/otel",
)
PY

parent_zip="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
otel_zip="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/otel/@v/v0.1.0.zip"
test -f "$parent_zip"
test -f "$otel_zip"
python3 - "$parent_zip" "$otel_zip" <<'PY'
from pathlib import Path
import sys
import zipfile

parent_zip = Path(sys.argv[1])
otel_zip = Path(sys.argv[2])
with zipfile.ZipFile(parent_zip) as archive:
    names = set(archive.namelist())
    if "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/otel/go.mod" in names:
        raise SystemExit("root Go module zip should not include nested OTel module")
    readme = archive.read("github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/README.md").decode("utf-8")
    if "github.com/LogBrewCo/sdk/go/logbrew/otel" not in readme:
        raise SystemExit("root README missing OTel bridge guidance")
with zipfile.ZipFile(otel_zip) as archive:
    names = set(archive.namelist())
    for expected in (
        "github.com/LogBrewCo/sdk/go/logbrew/otel@v0.1.0/go.mod",
        "github.com/LogBrewCo/sdk/go/logbrew/otel@v0.1.0/opentelemetry.go",
        "github.com/LogBrewCo/sdk/go/logbrew/otel@v0.1.0/README.md",
    ):
        if expected not in names:
            raise SystemExit(f"missing OTel module artifact file: {expected}")
PY

app_dir="$tmp_dir/go-otel-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
export GOPROXY="file://$proxy_dir,https://proxy.golang.org,direct"
export GOSUMDB=off

go mod init logbrew-go-otel-smoke >/dev/null
go mod edit -go=1.24.0
go get github.com/LogBrewCo/sdk/go/logbrew/otel@v0.1.0 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew/otel v0.1.0' go.mod
go list -m all > "$tmp_dir/go-otel-modules-before-remove.txt"
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' "$tmp_dir/go-otel-modules-before-remove.txt"
grep -q '^github.com/LogBrewCo/sdk/go/logbrew/otel v0.1.0$' "$tmp_dir/go-otel-modules-before-remove.txt"
grep -q '^go.opentelemetry.io/otel v1.41.0$' "$tmp_dir/go-otel-modules-before-remove.txt"
grep -q '^go.opentelemetry.io/otel/sdk v1.41.0$' "$tmp_dir/go-otel-modules-before-remove.txt"
go get github.com/LogBrewCo/sdk/go/logbrew/otel@none >/dev/null
if grep -q 'github.com/LogBrewCo/sdk/go/logbrew/otel' go.mod; then
	echo "expected go get @none to remove OTel bridge module requirement" >&2
	exit 1
fi
go get github.com/LogBrewCo/sdk/go/logbrew/otel@v0.1.0 >/dev/null

cat > main.go <<'GO'
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-otel-smoke",
		SDKVersion: "0.1.0",
	})
	must(err)
	exporter, err := logbrewotel.NewSpanExporter(client, logbrewotel.SpanExporterConfig{
		EventIDPrefix: "go_otel_smoke",
		Now: func() time.Time {
			return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
		},
		Metadata: map[string]any{"service": "checkout", "nested": map[string]any{"drop": true}},
	})
	must(err)
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)))

	parent := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID:    mustTraceID("4bf92f3577b34da6a3ce929d0e0e4736"),
		SpanID:     mustSpanID("00f067aa0ba902b7"),
		TraceFlags: oteltrace.FlagsSampled,
		Remote:     true,
	})
	linked := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID:    mustTraceID("11111111111111111111111111111111"),
		SpanID:     mustSpanID("2222222222222222"),
		TraceFlags: 0,
		Remote:     true,
	})
	ctx := oteltrace.ContextWithRemoteSpanContext(context.Background(), parent)
	copied, ok, err := logbrewotel.TraceContextFromContext(ctx, "b7ad6b7169203331")
	must(err)
	if !ok {
		panic("missing copied OTel trace")
	}
	must(client.Log("evt_otel_context_log", "2026-07-03T12:00:00Z", logbrew.LogAttributesWithTrace(
		logbrew.ContextWithLogBrewTrace(context.Background(), copied),
		logbrew.LogAttributes{Message: "otel context copied", Level: "info", Logger: "otel-smoke"},
	)))

	tracer := provider.Tracer("checkout-service", oteltrace.WithInstrumentationVersion("1.2.3"))
	_, span := tracer.Start(
		ctx,
		"GET /checkout/:cart_id",
		oteltrace.WithSpanKind(oteltrace.SpanKindServer),
		oteltrace.WithAttributes(
			attribute.String("http.request.method", "GET"),
			attribute.String("http.route", "/checkout/:cart_id"),
			attribute.Int("http.response.status_code", 502),
			attribute.String("exception.message", "private timeout details"),
			attribute.String("url.full", "https://api.example.test/checkout?debug=true"),
			attribute.String("db.statement", "select * from users where email='user@example.com'"),
			attribute.String("http.request.header.authorization", "Bearer private"),
		),
		oteltrace.WithLinks(oteltrace.Link{
			SpanContext: linked,
			Attributes: []attribute.KeyValue{
				attribute.String("messaging.system", "nats"),
				attribute.String("url.full", "https://queue.example.test/messages?debug=true"),
			},
		}),
	)
	span.SetStatus(codes.Error, "private timeout details")
	span.End()
	must(provider.Shutdown(context.Background()))

	payload, err := client.PreviewJSON()
	must(err)
	for _, unsafe := range []string{"user@example.com", "private timeout details", "debug=true", "authorization", "queue.example.test"} {
		if strings.Contains(payload, unsafe) {
			panic("unsafe OTel metadata leaked: " + unsafe)
		}
	}
	fmt.Println(payload)
	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"events":   2,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func mustTraceID(value string) oteltrace.TraceID {
	traceID, err := oteltrace.TraceIDFromHex(value)
	must(err)
	return traceID
}

func mustSpanID(value string) oteltrace.SpanID {
	spanID, err := oteltrace.SpanIDFromHex(value)
	must(err)
	return spanID
}
GO

GOFLAGS=-mod=readonly go run . > "$tmp_dir/go-otel.stdout.json" 2> "$tmp_dir/go-otel.stderr.json"
grep -q '"type": "log"' "$tmp_dir/go-otel.stdout.json"
grep -q '"type": "span"' "$tmp_dir/go-otel.stdout.json"
grep -q '"id": "go_otel_smoke_span_1"' "$tmp_dir/go-otel.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/go-otel.stdout.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/go-otel.stdout.json"
grep -q '"source": "opentelemetry.go"' "$tmp_dir/go-otel.stdout.json"
grep -q '"spanKind": "server"' "$tmp_dir/go-otel.stdout.json"
grep -q '"instrumentationScopeName": "checkout-service"' "$tmp_dir/go-otel.stdout.json"
grep -q '"instrumentationScopeVersion": "1.2.3"' "$tmp_dir/go-otel.stdout.json"
grep -q '"httpMethod": "GET"' "$tmp_dir/go-otel.stdout.json"
grep -q '"httpRoute": "/checkout/:cart_id"' "$tmp_dir/go-otel.stdout.json"
grep -q '"httpStatusCode": 502' "$tmp_dir/go-otel.stdout.json"
grep -q '"messagingSystem": "nats"' "$tmp_dir/go-otel.stdout.json"
grep -Eq '"status":[[:space:]]*202' "$tmp_dir/go-otel.stderr.json"
grep -Eq '"attempts":[[:space:]]*1' "$tmp_dir/go-otel.stderr.json"
grep -Eq '"events":[[:space:]]*2' "$tmp_dir/go-otel.stderr.json"
if grep -Eq 'user@example\.com|private timeout details|debug=true|authorization|queue\.example\.test' "$tmp_dir/go-otel.stdout.json"; then
	echo "OpenTelemetry smoke leaked unsafe metadata" >&2
	exit 1
fi

GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew/otel.NewSpanExporter > "$tmp_dir/go-otel-exporter-doc.txt"
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew/otel.TraceContextFromContext > "$tmp_dir/go-otel-context-doc.txt"
grep -q 'NewSpanExporter' "$tmp_dir/go-otel-exporter-doc.txt"
grep -q 'TraceContextFromContext' "$tmp_dir/go-otel-context-doc.txt"

printf '%s\n' "go opentelemetry installed-artifact smoke ok"
