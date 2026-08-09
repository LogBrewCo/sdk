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


def escape_path(path: str) -> str:
    return "".join("!" + char.lower() if "A" <= char <= "Z" else char for char in path)


def write_module(
    module_path: str,
    module_root: Path,
    version: str,
    *,
    exclude_nested: bool = False,
) -> None:
    version_dir = proxy / escape_path(module_path) / "@v"
    version_dir.mkdir(parents=True, exist_ok=True)
    (version_dir / "list").write_text(version + "\n")
    (version_dir / f"{version}.info").write_text(
        json.dumps({"Version": version, "Time": "2026-08-01T00:00:00Z"})
    )
    (version_dir / f"{version}.mod").write_text((module_root / "go.mod").read_text())
    zip_prefix = f"{module_path}@{version}/"
    with zipfile.ZipFile(
        version_dir / f"{version}.zip",
        "w",
        compression=zipfile.ZIP_DEFLATED,
    ) as archive:
        for path in module_root.rglob("*"):
            if not path.is_file() or ".git" in path.parts:
                continue
            relative = path.relative_to(module_root)
            if exclude_nested and relative.parts and relative.parts[0] in {"gin", "otel"}:
                continue
            archive.write(path, zip_prefix + relative.as_posix())


write_module(
    "github.com/LogBrewCo/sdk/go/logbrew",
    repo_root / "go/logbrew",
    "v0.1.6",
    exclude_nested=True,
)
write_module(
    "github.com/LogBrewCo/sdk/go/logbrew/gin",
    repo_root / "go/logbrew/gin",
    "v0.1.1",
)
PY

parent_zip="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.6.zip"
gin_zip="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/gin/@v/v0.1.1.zip"
test -f "$parent_zip"
test -f "$gin_zip"
python3 - "$parent_zip" "$gin_zip" <<'PY'
from pathlib import Path
import sys
import zipfile

parent_zip = Path(sys.argv[1])
gin_zip = Path(sys.argv[2])
with zipfile.ZipFile(parent_zip) as archive:
    names = set(archive.namelist())
    for nested in ("gin", "otel"):
        if f"github.com/LogBrewCo/sdk/go/logbrew@v0.1.6/{nested}/go.mod" in names:
            raise SystemExit(f"root Go module zip should not include nested {nested} module")
    readme = archive.read(
        "github.com/LogBrewCo/sdk/go/logbrew@v0.1.6/README.md"
    ).decode("utf-8")
    if "github.com/LogBrewCo/sdk/go/logbrew/gin" not in readme:
        raise SystemExit("root README missing Gin module guidance")
with zipfile.ZipFile(gin_zip) as archive:
    names = set(archive.namelist())
    for expected in (
        "github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1/go.mod",
        "github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1/go.sum",
        "github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1/middleware.go",
        "github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1/README.md",
    ):
        if expected not in names:
            raise SystemExit(f"missing Gin module artifact file: {expected}")
PY

app_dir="$tmp_dir/go-gin-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
export GOPROXY="file://$proxy_dir,https://proxy.golang.org,direct"
export GOSUMDB=off

go mod init logbrew-go-gin-smoke >/dev/null
go mod edit -go=1.24.0
go get github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1 >/dev/null
grep -q 'github.com/LogBrewCo/sdk/go/logbrew/gin v0.1.1' go.mod
if grep -q '^replace ' go.mod; then
	echo "installed Gin module proof must not use a source replacement" >&2
	exit 1
fi
go list -m all > "$tmp_dir/go-gin-modules-before-remove.txt"
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.6$' "$tmp_dir/go-gin-modules-before-remove.txt"
grep -q '^github.com/LogBrewCo/sdk/go/logbrew/gin v0.1.1$' "$tmp_dir/go-gin-modules-before-remove.txt"
grep -q '^github.com/gin-gonic/gin v1.11.0$' "$tmp_dir/go-gin-modules-before-remove.txt"
go get github.com/LogBrewCo/sdk/go/logbrew/gin@none >/dev/null
if grep -q 'github.com/LogBrewCo/sdk/go/logbrew/gin' go.mod; then
	echo "expected go get @none to remove Gin module requirement" >&2
	exit 1
fi
go get github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.1 >/dev/null

cat > gin_integration_test.go <<'GO'
package integration

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewgin "github.com/LogBrewCo/sdk/go/logbrew/gin"
	"github.com/gin-gonic/gin"
)

func TestInstalledGinMiddlewareRequestTracePanicAndPrivacy(t *testing.T) {
	gin.SetMode(gin.TestMode)
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-gin-installed-smoke",
		SDKVersion: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	middleware, err := logbrewgin.NewMiddleware(logbrewgin.Config{
		Client:                   client,
		CaptureRequestMetrics:   true,
		CaptureServerErrorIssues: true,
		EventIDPrefix:            "go_gin_installed",
		Metadata: map[string]any{
			"service":       "checkout-api",
			"authorization": "Bearer fixture-value",
		},
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	router.Use(gin.RecoveryWithWriter(io.Discard), middleware)
	router.GET("/articles/:slug", func(c *gin.Context) {
		trace, ok := logbrewgin.TraceFromContext(c)
		if !ok || trace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
			trace.ParentSpanID != "00f067aa0ba902b7" || trace.SpanID != "b7ad6b7169203331" {
			t.Fatalf("unexpected installed request trace: %#v", trace)
		}
		if err := client.Log(
			"evt_installed_handler_log",
			"2026-08-01T10:00:00Z",
			logbrew.LogAttributesWithTrace(c.Request.Context(), logbrew.LogAttributes{
				Message: "handler reached",
				Level:   "info",
				Logger:  "gin-installed-smoke",
			}),
		); err != nil {
			t.Fatal(err)
		}
		c.Status(http.StatusNoContent)
	})
	router.GET("/panic/:id", func(_ *gin.Context) {
		panic("private panic value")
	})

	request := httptest.NewRequest(
		http.MethodGet,
		"https://private.example.test/articles/private-article?token=private-query",
		nil,
	)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	request.Header.Set("Authorization", "Bearer request-fixture")
	request.Header.Set("Cookie", "session=private-cookie")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("unexpected request status: %d", response.Code)
	}

	panicResponse := httptest.NewRecorder()
	router.ServeHTTP(
		panicResponse,
		httptest.NewRequest(http.MethodGet, "/panic/private-id?token=private-panic-query", nil),
	)
	if panicResponse.Code != http.StatusInternalServerError {
		t.Fatalf("Gin recovery response changed: %d", panicResponse.Code)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var batch struct {
		Events []logbrew.Event `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 6 {
		t.Fatalf("unexpected installed Gin event count: %d\n%s", len(batch.Events), payload)
	}
	counts := map[string]int{}
	for _, event := range batch.Events {
		counts[event.Type]++
	}
	if counts["log"] != 1 || counts["span"] != 2 || counts["issue"] != 1 || counts["metric"] != 2 {
		t.Fatalf("unexpected installed Gin event types: %#v\n%s", counts, payload)
	}
	if !strings.Contains(payload, `"name": "GET /articles/:slug"`) ||
		!strings.Contains(payload, `"name": "GET /panic/:id"`) ||
		!strings.Contains(payload, `"title": "Gin request panicked"`) ||
		!strings.Contains(payload, `"panicType": "string"`) ||
		!strings.Contains(payload, `"exception": {`) ||
		!strings.Contains(payload, `"type": "gin.recovery"`) ||
		!strings.Contains(payload, `"handled": false`) ||
		!strings.Contains(payload, `"stackFrames": [`) ||
		!strings.Contains(payload, `"filename": "gin_integration_test.go"`) ||
		!strings.Contains(payload, `"name": "http.server.duration"`) ||
		!strings.Contains(payload, `"description": "Duration of one completed server request."`) ||
		!strings.Contains(payload, `"service": "checkout-api"`) {
		t.Fatalf("installed Gin telemetry missing expected correlation: %s", payload)
	}
	for _, unsafe := range []string{
		"private.example.test",
		"private-article",
		"private-query",
		"private-id",
		"private-panic-query",
		"private panic value",
		"request-fixture",
		"private-cookie",
		"fixture-value",
		"Authorization",
		"Cookie",
		"traceparent",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("installed Gin telemetry leaked %q: %s", unsafe, payload)
		}
	}
	result, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	if err != nil {
		t.Fatal(err)
	}
	if result.StatusCode != http.StatusAccepted || client.PendingEvents() != 0 {
		t.Fatalf("unexpected shutdown result: %#v pending=%d", result, client.PendingEvents())
	}
}
GO

GOFLAGS=-mod=readonly go test ./...
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew/gin.NewMiddleware > "$tmp_dir/go-gin-middleware-doc.txt"
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew/gin.TraceFromContext > "$tmp_dir/go-gin-trace-doc.txt"
grep -q 'NewMiddleware' "$tmp_dir/go-gin-middleware-doc.txt"
grep -q 'TraceFromContext' "$tmp_dir/go-gin-trace-doc.txt"

printf '%s\n' "go gin installed-artifact smoke ok"
