#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
teardown_tmp_dir() {
	chmod -R u+w "$tmp_dir" 2>/dev/null || true
	rm -rf "$tmp_dir"
}
trap teardown_tmp_dir EXIT
export GOMODCACHE="$tmp_dir/pkg/mod"
mkdir -p "$GOMODCACHE"

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
    parts: list[str] = []
    for ch in path:
        if "A" <= ch <= "Z":
            parts.append("!" + ch.lower())
        else:
            parts.append(ch)
    return "".join(parts)


escaped_path = escape_path(module_path)
version_dir = proxy / escaped_path / "@v"
version_dir.mkdir(parents=True, exist_ok=True)
(version_dir / "list").write_text(version + "\n")
(version_dir / f"{version}.info").write_text(
    json.dumps({"Version": version, "Time": "2026-06-03T00:00:00Z"})
)
(version_dir / f"{version}.mod").write_text((repo / "go.mod").read_text())

zip_prefix = f"{module_path}@{version}/"
with zipfile.ZipFile(
    version_dir / f"{version}.zip", "w", compression=zipfile.ZIP_DEFLATED
) as archive:
    for path in repo.rglob("*"):
        if path.is_file() and ".git" not in path.parts:
            archive.write(path, zip_prefix + path.relative_to(repo).as_posix())
PY
info_file="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.info"
mod_file="$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.mod"
test -f "$info_file"
test -f "$mod_file"
grep -q '^module github.com/LogBrewCo/sdk/go/logbrew$' "$mod_file"
grep -q '^go 1.24.0$' "$mod_file"
python3 - "$info_file" <<'PY'
import json
import sys
from pathlib import Path

payload = json.loads(Path(sys.argv[1]).read_text())
if payload.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected proxy module version: {payload.get('Version')!r}")
if payload.get("Time") != "2026-06-03T00:00:00Z":
    raise SystemExit(f"unexpected proxy module time: {payload.get('Time')!r}")
PY
test -f "$proxy_dir/github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
python3 - <<'PY'
from pathlib import Path
import os
import zipfile

zip_path = (
    Path(os.environ["LOGBREW_GO_PROXY_DIR"])
    / "github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
)
with zipfile.ZipFile(zip_path) as archive:
    names = set(archive.namelist())
    readme_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/README.md"
    if readme_path not in names:
        raise SystemExit("missing README.md in proxy module zip")
    http_client_trace_source_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/http_client_trace.go"
    if http_client_trace_source_path not in names:
        raise SystemExit("missing http_client_trace.go in proxy module zip")
    operation_trace_source_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/operation_trace.go"
    if operation_trace_source_path not in names:
        raise SystemExit("missing operation_trace.go in proxy module zip")
    readme_example_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/readme_example/main.go"
    if readme_example_path not in names:
        raise SystemExit("missing examples/readme_example/main.go in proxy module zip")
    agent_timeline_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/agent_timeline/main.go"
    if agent_timeline_path not in names:
        raise SystemExit("missing examples/agent_timeline/main.go in proxy module zip")
    first_useful_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/first_useful_telemetry/main.go"
    if first_useful_path not in names:
        raise SystemExit("missing examples/first_useful_telemetry/main.go in proxy module zip")
    http_client_trace_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/http_client_trace/main.go"
    if http_client_trace_path not in names:
        raise SystemExit("missing examples/http_client_trace/main.go in proxy module zip")
    http_trace_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/http_trace_correlation/main.go"
    if http_trace_path not in names:
        raise SystemExit("missing examples/http_trace_correlation/main.go in proxy module zip")
    examples_makefile_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/Makefile"
    if examples_makefile_path not in names:
        raise SystemExit("missing examples/Makefile in proxy module zip")
    example_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/real_user_smoke/main.go"
    if example_path not in names:
        raise SystemExit("missing examples/real_user_smoke/main.go in proxy module zip")
    makefile_path = "github.com/LogBrewCo/sdk/go/logbrew@v0.1.0/examples/real_user_smoke/Makefile"
    if makefile_path not in names:
        raise SystemExit("missing examples/real_user_smoke/Makefile in proxy module zip")
    readme = archive.read(readme_path).decode("utf-8")
for needle in (
    "go get github.com/LogBrewCo/sdk/go/logbrew",
    "LOGBREW_API_KEY",
    "PreviewJSON",
    "ParseTraceparent",
    "CreateTraceparent",
    "SpanAttributesFromTraceparent",
    "NewTraceContext",
    "LogBrewTraceFromContext",
    "LogAttributesWithTrace",
    "IssueAttributesWithTrace",
    "NewHTTPHandler",
    "NewHTTPClientTransport",
    "NewSlogHandler",
    "DatabaseOperationWithLogBrewSpan",
    "SQLQueryContextWithLogBrewSpan",
    "SQLExecContextWithLogBrewSpan",
    "SQLStatementQueryContextRunner",
    "SQLStatementExecContextRunner",
    "CacheOperationWithLogBrewSpan",
    "QueueOperationWithLogBrewSpan",
    "CreateProductActionAttributes",
    "CreateNetworkMilestoneAttributes",
    "HTTPTransport",
    "NewHTTPTransport",
    "MetricAttributes",
    "client.Metric",
    "First Useful Telemetry",
    "examples/agent_timeline",
    "examples/first_useful_telemetry",
    "examples/http_trace_correlation",
    "copyable snippets",
    "your own Go service",
):
    if needle not in readme:
        raise SystemExit(f"missing proxy README guidance: {needle}")
PY

module_src_root="$tmp_dir/extracted-module"
mkdir -p "$module_src_root"
export LOGBREW_GO_EXTRACT_DIR="$module_src_root"
python3 - <<'PY'
from pathlib import Path
import os
import zipfile

zip_path = (
    Path(os.environ["LOGBREW_GO_PROXY_DIR"])
    / "github.com/!log!brew!co/sdk/go/logbrew/@v/v0.1.0.zip"
)
extract_root = Path(os.environ["LOGBREW_GO_EXTRACT_DIR"])
with zipfile.ZipFile(zip_path) as archive:
    archive.extractall(extract_root)
PY
module_dir="$module_src_root/github.com/LogBrewCo/sdk/go/logbrew@v0.1.0"
test -f "$module_dir/go.mod"
test -f "$module_dir/http_client_trace.go"
test -f "$module_dir/operation_trace.go"
test -f "$module_dir/examples/Makefile"
test -f "$module_dir/examples/agent_timeline/main.go"
test -f "$module_dir/examples/first_useful_telemetry/main.go"
test -f "$module_dir/examples/http_client_trace/main.go"
test -f "$module_dir/examples/http_trace_correlation/main.go"
test -f "$module_dir/examples/readme_example/main.go"
test -f "$module_dir/examples/real_user_smoke/main.go"
test -f "$module_dir/examples/real_user_smoke/Makefile"
grep -q '^\.PHONY: help run run-agent-timeline run-first-useful-telemetry run-http-client-trace run-http-trace-correlation run-readme-example run-real-user-smoke$' "$module_dir/examples/Makefile"
grep -q '^help:$' "$module_dir/examples/Makefile"
grep -q '^run: run-real-user-smoke$' "$module_dir/examples/Makefile"
grep -q '^run-agent-timeline:$' "$module_dir/examples/Makefile"
grep -q '^run-first-useful-telemetry:$' "$module_dir/examples/Makefile"
grep -q '^run-http-client-trace:$' "$module_dir/examples/Makefile"
grep -q '^run-http-trace-correlation:$' "$module_dir/examples/Makefile"
grep -q '^run-readme-example:$' "$module_dir/examples/Makefile"
grep -q '^run-real-user-smoke:$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./agent_timeline$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./first_useful_telemetry$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./http_client_trace$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./http_trace_correlation$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./readme_example$' "$module_dir/examples/Makefile"
grep -q '^	@go run \./real_user_smoke$' "$module_dir/examples/Makefile"
grep -q '^\.PHONY: help run run-real-user-smoke$' "$module_dir/examples/real_user_smoke/Makefile"
grep -q '^help:$' "$module_dir/examples/real_user_smoke/Makefile"
grep -q '^run: run-real-user-smoke$' "$module_dir/examples/real_user_smoke/Makefile"
grep -q '^run-real-user-smoke:$' "$module_dir/examples/real_user_smoke/Makefile"
grep -q '^	@go run \.$' "$module_dir/examples/real_user_smoke/Makefile"
(cd "$module_dir" && go run ./examples/readme_example) > "$tmp_dir/packaged-readme-example.stdout.json" 2> "$tmp_dir/packaged-readme-example.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-readme-example.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-readme-example.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme-example.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-readme-example.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-readme-example.stderr.json"
(cd "$module_dir/examples" && make) > "$tmp_dir/packaged-examples-make-help.txt"
grep -qx 'run-agent-timeline -> make run-agent-timeline' <(sed -n '1p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run-first-useful-telemetry -> make run-first-useful-telemetry' <(sed -n '2p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run-http-client-trace -> make run-http-client-trace' <(sed -n '3p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run-http-trace-correlation -> make run-http-trace-correlation' <(sed -n '4p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run-readme-example -> make run-readme-example' <(sed -n '5p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '6p' "$tmp_dir/packaged-examples-make-help.txt")
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '7p' "$tmp_dir/packaged-examples-make-help.txt")
test "$(wc -l < "$tmp_dir/packaged-examples-make-help.txt" | tr -d ' ')" = "7"
(cd "$module_dir/examples" && make run-agent-timeline) > "$tmp_dir/packaged-agent-timeline.stdout.txt" 2> "$tmp_dir/packaged-agent-timeline.stderr.txt"
grep -q '"source": "product.action"' "$tmp_dir/packaged-agent-timeline.stdout.txt"
grep -q '"source": "network.milestone"' "$tmp_dir/packaged-agent-timeline.stdout.txt"
grep -q '"routeTemplate": "/checkout/:step"' "$tmp_dir/packaged-agent-timeline.stdout.txt"
grep -q '"routeTemplate": "/v1/payments/:id"' "$tmp_dir/packaged-agent-timeline.stdout.txt"
grep -q '00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01' "$tmp_dir/packaged-agent-timeline.stdout.txt"
if grep -Eq 'email=user@example\.com|debug=true|payload|headers' "$tmp_dir/packaged-agent-timeline.stdout.txt"; then
	echo "packaged agent timeline leaked unsafe route or metadata values" >&2
	exit 1
fi
(cd "$module_dir/examples" && make run-first-useful-telemetry) > "$tmp_dir/packaged-first-useful.stdout.json" 2> "$tmp_dir/packaged-first-useful.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-first-useful.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-first-useful.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-first-useful.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-first-useful.stdout.json"
grep -q '"type": "metric"' "$tmp_dir/packaged-first-useful.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-first-useful.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-first-useful.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_go_first_useful_payload.py" "$tmp_dir/packaged-first-useful.stdout.json" "$tmp_dir/packaged-first-useful.stderr.json" >/dev/null
(cd "$module_dir/examples" && make run-http-client-trace) > "$tmp_dir/packaged-http-client-trace.stdout.json" 2> "$tmp_dir/packaged-http-client-trace.stderr.json"
grep -q '"type": "span"' "$tmp_dir/packaged-http-client-trace.stdout.json"
grep -q '"source": "net/http.client"' "$tmp_dir/packaged-http-client-trace.stdout.json"
grep -q '"routeTemplate": "/payments/:payment_id"' "$tmp_dir/packaged-http-client-trace.stdout.json"
grep -q '"method": "GET"' "$tmp_dir/packaged-http-client-trace.stdout.json"
grep -q '"statusCode": 202' "$tmp_dir/packaged-http-client-trace.stdout.json"
grep -q '"downstreamTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' "$tmp_dir/packaged-http-client-trace.stderr.json"
grep -q '"callerTraceparent":"spoofed"' "$tmp_dir/packaged-http-client-trace.stderr.json"
grep -q '"events":1' "$tmp_dir/packaged-http-client-trace.stderr.json"
if grep -Eq 'coupon=summer|receipt|traceparent|spoofed|authorization' "$tmp_dir/packaged-http-client-trace.stdout.json"; then
	echo "packaged HTTP client trace leaked unsafe route or propagation values" >&2
	exit 1
fi
(cd "$module_dir/examples" && make run-http-trace-correlation) > "$tmp_dir/packaged-http-trace.stdout.json" 2> "$tmp_dir/packaged-http-trace.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-http-trace.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-http-trace.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-http-trace.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-http-trace.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-http-trace.stdout.json"
grep -q '"type": "metric"' "$tmp_dir/packaged-http-trace.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-http-trace.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_go_http_trace_payload.py" "$tmp_dir/packaged-http-trace.stdout.json" "$tmp_dir/packaged-http-trace.stderr.json" >/dev/null
(cd "$module_dir/examples" && make run-readme-example) > "$tmp_dir/packaged-readme-example-make.stdout.json" 2> "$tmp_dir/packaged-readme-example-make.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-readme-example-make.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-readme-example-make.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-readme-example-make.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-readme-example-make.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-readme-example-make.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-readme-example-make.stderr.json"
(cd "$module_dir" && go run ./examples/real_user_smoke) > "$tmp_dir/packaged-example.stdout.json" 2> "$tmp_dir/packaged-example.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-example.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-example.stderr.json"
(cd "$module_dir/examples" && make run-real-user-smoke) > "$tmp_dir/packaged-examples-make.stdout.json" 2> "$tmp_dir/packaged-examples-make.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-examples-make.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-examples-make.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-examples-make.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-examples-make.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-examples-make.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-examples-make.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-examples-make.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-examples-make.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-examples-make.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-examples-make.stderr.json"
(cd "$module_dir/examples" && make run) > "$tmp_dir/packaged-examples-make-alias.stdout.json" 2> "$tmp_dir/packaged-examples-make-alias.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-examples-make-alias.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-examples-make-alias.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-examples-make-alias.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-examples-make-alias.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-examples-make-alias.stderr.json"
(cd "$module_dir/examples/real_user_smoke" && make) > "$tmp_dir/packaged-example-make-help.txt"
grep -qx 'run (real-user-smoke) -> make run' <(sed -n '1p' "$tmp_dir/packaged-example-make-help.txt")
grep -qx 'run-real-user-smoke -> make run-real-user-smoke' <(sed -n '2p' "$tmp_dir/packaged-example-make-help.txt")
test "$(wc -l < "$tmp_dir/packaged-example-make-help.txt" | tr -d ' ')" = "2"
(cd "$module_dir/examples/real_user_smoke" && make run-real-user-smoke) > "$tmp_dir/packaged-example-make.stdout.json" 2> "$tmp_dir/packaged-example-make.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example-make.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example-make.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example-make.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example-make.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-example-make.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-example-make.stderr.json"
(cd "$module_dir/examples/real_user_smoke" && make run) > "$tmp_dir/packaged-example-make-alias.stdout.json" 2> "$tmp_dir/packaged-example-make-alias.stderr.json"
grep -q '"type": "release"' "$tmp_dir/packaged-example-make-alias.stdout.json"
grep -q '"type": "environment"' "$tmp_dir/packaged-example-make-alias.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/packaged-example-make-alias.stdout.json"
grep -q '"type": "log"' "$tmp_dir/packaged-example-make-alias.stdout.json"
grep -q '"type": "span"' "$tmp_dir/packaged-example-make-alias.stdout.json"
grep -q '"type": "action"' "$tmp_dir/packaged-example-make-alias.stdout.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/packaged-example-make-alias.stdout.json" >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" "$tmp_dir/packaged-example-make-alias.stdout.json" >/dev/null
grep -q '"events":' "$tmp_dir/packaged-example-make-alias.stderr.json"
grep -q '"ok":' "$tmp_dir/packaged-example-make-alias.stderr.json"

cd "$tmp_dir"
mkdir lifecycle-app
cd lifecycle-app
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off

go mod init lifecycle-app >/dev/null
go mod edit -go=1.24.0
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q '^module lifecycle-app$' go.mod
grep -q '^go 1.24.0$' go.mod
grep -q '^require github.com/LogBrewCo/sdk/go/logbrew v0.1.0 // indirect$' go.mod
go list -m all > lifecycle-module-graph.txt
grep -q '^lifecycle-app$' lifecycle-module-graph.txt
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' lifecycle-module-graph.txt
go get github.com/LogBrewCo/sdk/go/logbrew@none >/dev/null
grep -q '^module lifecycle-app$' go.mod
grep -q '^go 1.24.0$' go.mod
if grep -q 'github.com/LogBrewCo/sdk/go/logbrew' go.mod; then
	echo "expected go.mod to remove SDK dependency after go get @none" >&2
	exit 1
fi
go list -m all > lifecycle-module-graph-removed.txt
grep -q '^lifecycle-app$' lifecycle-module-graph-removed.txt
if grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' lifecycle-module-graph-removed.txt; then
	echo "expected go list -m all to omit SDK module after go get @none" >&2
	exit 1
fi
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q '^require github.com/LogBrewCo/sdk/go/logbrew v0.1.0 // indirect$' go.mod
go list -m all > lifecycle-module-graph-readded.txt
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' lifecycle-module-graph-readded.txt

cd "$tmp_dir"
mkdir smoke-app
cd smoke-app
export GOPROXY="file://$proxy_dir"
export GOSUMDB=off

go mod init smoke-app >/dev/null
go mod edit -go=1.24.0

cat > main.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		panic(err)
	}

	must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Public release marker",
	}))
	must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
	}))
	must(client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", logbrew.IssueAttributes{
		Title:   "Checkout timeout",
		Level:   "error",
		Message: "Request timed out after retry budget",
	}))
	must(client.Log("evt_log_001", "2026-06-02T10:00:03Z", logbrew.LogAttributes{
		Message: "worker started",
		Level:   "info",
		Logger:  "job-runner",
	}))
	duration := 12.5
	must(client.Span("evt_span_001", "2026-06-02T10:00:04Z", logbrew.SpanAttributes{
		Name:       "GET /health",
		TraceID:    "trace_001",
		SpanID:     "span_001",
		Status:     "ok",
		DurationMs: &duration,
	}))
	must(client.Action("evt_action_001", "2026-06-02T10:00:05Z", logbrew.ActionAttributes{
		Name:   "deploy",
		Status: "success",
	}))

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)

	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"events":   6,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

mkdir -p readme-example

cat > readme-example/main.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "logbrew-go",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		panic(err)
	}

	must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Public release marker",
	}))
	must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
	}))
	must(client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", logbrew.IssueAttributes{
		Title:   "Checkout timeout",
		Level:   "error",
		Message: "Request timed out after retry budget",
	}))
	must(client.Log("evt_log_001", "2026-06-02T10:00:03Z", logbrew.LogAttributes{
		Message: "worker started",
		Level:   "info",
		Logger:  "job-runner",
	}))
	duration := 12.5
	must(client.Span("evt_span_001", "2026-06-02T10:00:04Z", logbrew.SpanAttributes{
		Name:       "GET /health",
		TraceID:    "trace_001",
		SpanID:     "span_001",
		Status:     "ok",
		DurationMs: &duration,
	}))
	must(client.Action("evt_action_001", "2026-06-02T10:00:05Z", logbrew.ActionAttributes{
		Name:   "deploy",
		Status: "success",
	}))

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)

	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"events":   6,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

cat > Makefile <<'EOF'
GOFLAGS_READONLY=-mod=readonly

.PHONY: smoke-build smoke-test smoke-vet smoke-run smoke-readme smoke-traceparent

smoke-build:
	@GOFLAGS=$(GOFLAGS_READONLY) go build ./...
	@GOFLAGS=$(GOFLAGS_READONLY) go build -o smoke-app-bin .

smoke-test:
	@GOFLAGS=$(GOFLAGS_READONLY) go test ./...

smoke-vet:
	@GOFLAGS=$(GOFLAGS_READONLY) go vet ./...

smoke-run:
	@GOFLAGS=$(GOFLAGS_READONLY) go run .

smoke-readme:
	@GOFLAGS=$(GOFLAGS_READONLY) go run ./readme-example

smoke-traceparent:
	@GOFLAGS=$(GOFLAGS_READONLY) go run ./traceparent
EOF
grep -q '^GOFLAGS_READONLY=-mod=readonly$' Makefile
grep -q '^smoke-build:$' Makefile
grep -q '^smoke-test:$' Makefile
grep -q '^smoke-vet:$' Makefile
grep -q '^smoke-run:$' Makefile
grep -q '^smoke-readme:$' Makefile
grep -q '^smoke-traceparent:$' Makefile

cat > smoke_test.go <<'EOF'
package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func TestInstalledClientPreview(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app-test",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatalf("create client: %v", err)
	}

	if err := client.Release(
		"evt_release_test",
		"2026-06-02T10:00:00Z",
		logbrew.ReleaseAttributes{Version: "1.2.3"},
	); err != nil {
		t.Fatalf("queue release: %v", err)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview json: %v", err)
	}
	if !strings.Contains(payload, "\"type\": \"release\"") {
		t.Fatalf("preview missing release event: %s", payload)
	}
}

func TestInstalledClientMetricPreview(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app-test",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatalf("create client: %v", err)
	}

	if err := client.Metric(
		"evt_metric_test",
		"2026-06-02T10:00:06Z",
		logbrew.MetricAttributes{
			Name:        "queue.depth",
			Kind:        "gauge",
			Value:       42,
			Unit:        "{items}",
			Temporality: "instant",
			Metadata:    map[string]any{"service": "worker"},
		},
	); err != nil {
		t.Fatalf("queue metric: %v", err)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview json: %v", err)
	}
	if !strings.Contains(payload, "\"type\": \"metric\"") {
		t.Fatalf("preview missing metric event: %s", payload)
	}
	if !strings.Contains(payload, "\"temporality\": \"instant\"") {
		t.Fatalf("preview missing metric temporality: %s", payload)
	}
}

func TestInstalledTraceparentHelpers(t *testing.T) {
	traceparent := "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
	context, err := logbrew.ParseTraceparent(traceparent)
	if err != nil {
		t.Fatalf("parse traceparent: %v", err)
	}
	if context.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("unexpected trace id: %s", context.TraceID)
	}
	if context.ParentSpanID != "00f067aa0ba902b7" {
		t.Fatalf("unexpected parent span id: %s", context.ParentSpanID)
	}
	if !context.Sampled {
		t.Fatalf("expected sampled traceparent")
	}

	created, err := logbrew.CreateTraceparent(context.TraceID, "B7AD6B7169203331", "")
	if err != nil {
		t.Fatalf("create traceparent: %v", err)
	}
	if created != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01" {
		t.Fatalf("unexpected created traceparent: %s", created)
	}

	attributes, err := logbrew.SpanAttributesFromTraceparent(logbrew.TraceparentSpanInput{
		Traceparent: traceparent,
		Name:        "GET /health",
		SpanID:      "B7AD6B7169203331",
		Status:      "ok",
		Metadata: map[string]any{
			"framework": "net/http",
			"status":    200,
			"nested":    map[string]any{"drop": true},
		},
	})
	if err != nil {
		t.Fatalf("derive span attributes: %v", err)
	}
	if attributes.TraceID != context.TraceID ||
		attributes.ParentSpanID != context.ParentSpanID ||
		attributes.SpanID != "b7ad6b7169203331" {
		t.Fatalf("unexpected continued span attributes: %#v", attributes)
	}
	if attributes.Metadata["framework"] != "net/http" || attributes.Metadata["status"] != 200 {
		t.Fatalf("missing primitive metadata: %#v", attributes.Metadata)
	}
	if _, ok := attributes.Metadata["nested"]; ok {
		t.Fatalf("expected nested metadata to be filtered: %#v", attributes.Metadata)
	}
	if _, err := logbrew.ParseTraceparent("00-00000000000000000000000000000000-00f067aa0ba902b7-01"); err == nil {
		t.Fatalf("expected malformed traceparent to fail")
	}
}

func TestInstalledTimelineHelpers(t *testing.T) {
	statusCode := 503
	durationMs := 82.5
	action, err := logbrew.CreateProductActionAttributes(logbrew.ProductActionInput{
		Name:          "checkout.submit",
		RouteTemplate: "https://app.example/checkout/:step?email=user@example.com#pay",
		Metadata:      map[string]any{"nested": map[string]any{"drop": true}},
	})
	if err != nil {
		t.Fatalf("create product action attributes: %v", err)
	}
	network, err := logbrew.CreateNetworkMilestoneAttributes(logbrew.NetworkMilestoneInput{
		RouteTemplate: "https://api.example/v1/orders/:id?debug=true#trace",
		Method:        "post",
		StatusCode:    &statusCode,
		DurationMs:    &durationMs,
		SessionID:     "sess_123",
		TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
	})
	if err != nil {
		t.Fatalf("create network milestone attributes: %v", err)
	}
	if action.Metadata["routeTemplate"] != "/checkout/:step" ||
		action.Metadata["source"] != "product.action" {
		t.Fatalf("unexpected product action metadata: %#v", action.Metadata)
	}
	if network.Name != "network.post /v1/orders/:id" ||
		network.Status != "failure" ||
		network.Metadata["routeTemplate"] != "/v1/orders/:id" ||
		network.Metadata["method"] != "POST" ||
		network.Metadata["statusCode"] != 503 ||
		network.Metadata["durationMs"] != 82.5 {
		t.Fatalf("unexpected network milestone attributes: %#v", network)
	}
	if _, ok := action.Metadata["nested"]; ok {
		t.Fatalf("expected nested product action metadata to be filtered: %#v", action.Metadata)
	}
}

func TestInstalledSQLContextHelpers(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app-test",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatalf("create client: %v", err)
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
	stmtQueryer := &fakeSQLStmtQueryer{}
	stmtExecer := &fakeSQLStmtExecer{result: fakeSQLResult{rowsAffected: 4}}

	_, err = logbrew.SQLQueryContextWithLogBrewSpan(
		ctx,
		client,
		queryer,
		"lookup checkout order",
		"SELECT * FROM orders WHERE account_ref = ?",
		logbrew.DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "go_sql_query_test",
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
		queryer.args[0] != "opaque-ref-value" {
		t.Fatalf("query helper did not preserve app-owned query call: query=%q args=%#v", queryer.query, queryer.args)
	}
	if queryer.trace.TraceID != parent.TraceID ||
		queryer.trace.ParentSpanID != parent.SpanID ||
		queryer.trace.SpanID != "b7ad6b7169203335" {
		t.Fatalf("query helper did not activate child trace: %#v", queryer.trace)
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
			EventIDPrefix: "go_sql_exec_test",
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
		execer.args[1] != "order-ref-value" {
		t.Fatalf("exec helper did not preserve app-owned exec call: query=%q args=%#v", execer.query, execer.args)
	}
	if execer.trace.TraceID != parent.TraceID ||
		execer.trace.ParentSpanID != parent.SpanID ||
		execer.trace.SpanID != "b7ad6b7169203336" {
		t.Fatalf("exec helper did not activate child trace: %#v", execer.trace)
	}

	_, err = logbrew.SQLQueryContextWithLogBrewSpan(
		ctx,
		client,
		stmtQueryer,
		"prepared lookup checkout order",
		"SELECT * FROM orders WHERE account_ref = ?",
		logbrew.DatabaseOperationConfig{
			EventIDPrefix: "go_sql_stmt_query_test",
			SpanIDFactory: func() string {
				return "b7ad6b7169203337"
			},
		},
		"opaque-ref-value",
	)
	if err != nil {
		t.Fatalf("statement query helper returned error: %v", err)
	}
	if stmtQueryer.queryTextReceived ||
		len(stmtQueryer.args) != 1 ||
		stmtQueryer.args[0] != "opaque-ref-value" ||
		stmtQueryer.trace.SpanID != "b7ad6b7169203337" {
		t.Fatalf("statement query helper did not use statement-style runner: %#v", stmtQueryer)
	}

	_, err = logbrew.SQLExecContextWithLogBrewSpan(
		ctx,
		client,
		stmtExecer,
		"prepared update checkout order",
		"UPDATE orders SET status = ? WHERE id = ?",
		logbrew.DatabaseOperationConfig{
			EventIDPrefix: "go_sql_stmt_exec_test",
			SpanIDFactory: func() string {
				return "b7ad6b7169203338"
			},
		},
		"paid",
		"order-ref-value",
	)
	if err != nil {
		t.Fatalf("statement exec helper returned error: %v", err)
	}
	if stmtExecer.queryTextReceived ||
		len(stmtExecer.args) != 2 ||
		stmtExecer.args[0] != "paid" ||
		stmtExecer.args[1] != "order-ref-value" ||
		stmtExecer.trace.SpanID != "b7ad6b7169203338" {
		t.Fatalf("statement exec helper did not use statement-style runner: %#v", stmtExecer)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatalf("preview json: %v", err)
	}
	for _, want := range []string{
		`"dbOperation": "lookup checkout order"`,
		`"dbOperationKind": "query"`,
		`"dbOperation": "update checkout order"`,
		`"dbOperationKind": "exec"`,
		`"rowCount": 2`,
		`"dbOperation": "prepared lookup checkout order"`,
		`"dbOperation": "prepared update checkout order"`,
		`"rowCount": 4`,
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

type fakeSQLStmtQueryer struct {
	queryTextReceived bool
	args              []any
	trace             logbrew.TraceContext
}

func (q *fakeSQLStmtQueryer) QueryContext(ctx context.Context, args ...any) (*sql.Rows, error) {
	q.args = append([]any{}, args...)
	if len(args) > 0 {
		if value, ok := args[0].(string); ok && strings.Contains(value, "SELECT * FROM orders") {
			q.queryTextReceived = true
		}
	}
	trace, ok := logbrew.LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	q.trace = trace
	return nil, nil
}

type fakeSQLStmtExecer struct {
	queryTextReceived bool
	args              []any
	trace             logbrew.TraceContext
	result            sql.Result
}

func (e *fakeSQLStmtExecer) ExecContext(ctx context.Context, args ...any) (sql.Result, error) {
	e.args = append([]any{}, args...)
	if len(args) > 0 {
		if value, ok := args[0].(string); ok && strings.Contains(value, "UPDATE orders") {
			e.queryTextReceived = true
		}
	}
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
	return 0, errors.New("last insert id unsupported")
}

func (r fakeSQLResult) RowsAffected() (int64, error) {
	return r.rowsAffected, nil
}
EOF

mkdir -p traceparent

cat > traceparent/main.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	traceparent := "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01"
	context, err := logbrew.ParseTraceparent(traceparent)
	must(err)
	created, err := logbrew.CreateTraceparent(context.TraceID, "B7AD6B7169203331", "")
	must(err)
	duration := 8.5
	attributes, err := logbrew.SpanAttributesFromTraceparent(logbrew.TraceparentSpanInput{
		Traceparent: traceparent,
		Name:        "GET /health",
		SpanID:      "B7AD6B7169203331",
		Status:      "ok",
		DurationMs:  &duration,
		Metadata: map[string]any{
			"framework": "net/http",
			"sampled":   context.Sampled,
			"status":    200,
			"nested":    map[string]any{"drop": true},
		},
	})
	must(err)
	if _, err := logbrew.ParseTraceparent("ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"); err == nil {
		panic("expected forbidden version to fail")
	}
	_, hasNested := attributes.Metadata["nested"]
	must(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"created":      created,
		"durationMs":   *attributes.DurationMs,
		"hasNested":    hasNested,
		"ok":           true,
		"parentSpanId": attributes.ParentSpanID,
		"sampled":      context.Sampled,
		"spanId":       attributes.SpanID,
		"traceFlags":   context.TraceFlags,
		"traceId":      attributes.TraceID,
	}))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null
grep -q '^require github.com/LogBrewCo/sdk/go/logbrew v0.1.0 // indirect$' go.mod
go mod tidy
grep -q '^module smoke-app$' go.mod
grep -q '^go 1.24.0$' go.mod
grep -q '^require github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' go.mod
test -f go.sum
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0 h1:' go.sum
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0/go.mod h1:' go.sum
go mod verify >/dev/null
GOFLAGS=-mod=readonly go mod download -json github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 > sdk-download.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("sdk-download.json").read_text())
if payload.get("Path") != "github.com/LogBrewCo/sdk/go/logbrew":
    raise SystemExit(f"unexpected Go download path: {payload.get('Path')}")
if payload.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected Go download version: {payload.get('Version')}")
info_path = str(payload.get("Info", ""))
if "/pkg/mod/cache/download/" not in info_path or not info_path.endswith("/@v/v0.1.0.info"):
    raise SystemExit(f"unexpected Go download info path: {info_path}")
go_mod_path = str(payload.get("GoMod", ""))
if "/pkg/mod/cache/download/" not in go_mod_path or not go_mod_path.endswith("/@v/v0.1.0.mod"):
    raise SystemExit(f"unexpected Go download mod path: {go_mod_path}")
zip_path = str(payload.get("Zip", ""))
if "/pkg/mod/cache/download/" not in zip_path or not zip_path.endswith("/@v/v0.1.0.zip"):
    raise SystemExit(f"unexpected Go download zip path: {zip_path}")
module_dir = str(payload.get("Dir", ""))
if "/pkg/mod/" not in module_dir or not module_dir.endswith("/go/logbrew@v0.1.0"):
    raise SystemExit(f"unexpected Go download dir: {module_dir}")
sum_value = str(payload.get("Sum", ""))
if not sum_value.startswith("h1:"):
    raise SystemExit(f"unexpected Go download sum: {sum_value}")
go_mod_sum = str(payload.get("GoModSum", ""))
if not go_mod_sum.startswith("h1:"):
    raise SystemExit(f"unexpected Go download go.mod sum: {go_mod_sum}")

go_sum_lines = Path("go.sum").read_text().splitlines()
module_sum_line = f"github.com/LogBrewCo/sdk/go/logbrew v0.1.0 {sum_value}"
go_mod_sum_line = f"github.com/LogBrewCo/sdk/go/logbrew v0.1.0/go.mod {go_mod_sum}"
if module_sum_line not in go_sum_lines:
    raise SystemExit("go mod download sum did not match go.sum")
if go_mod_sum_line not in go_sum_lines:
    raise SystemExit("go mod download go.mod sum did not match go.sum")
PY
GOFLAGS=-mod=readonly go list -m all > module-graph.txt
grep -q '^smoke-app$' module-graph.txt
grep -q '^github.com/LogBrewCo/sdk/go/logbrew v0.1.0$' module-graph.txt
GOFLAGS=-mod=readonly go list -m -json all > module-graph.json
python3 - <<'PY'
import json
from pathlib import Path

decoder = json.JSONDecoder()
payload = Path("module-graph.json").read_text()
index = 0
modules = []
while index < len(payload):
    while index < len(payload) and payload[index].isspace():
        index += 1
    if index >= len(payload):
        break
    item, next_index = decoder.raw_decode(payload, index)
    modules.append(item)
    index = next_index

root = next((item for item in modules if item.get("Main") is True), None)
if root is None:
    raise SystemExit("missing root module in go list -m -json all output")
if root.get("Path") != "smoke-app":
    raise SystemExit(f"unexpected root module path: {root.get('Path')!r}")
if str(root.get("GoMod", "")).endswith("/smoke-app/go.mod") is False:
    raise SystemExit(f"unexpected root go.mod path: {root.get('GoMod')!r}")
if root.get("GoVersion") != "1.24.0":
    raise SystemExit(f"unexpected root Go version: {root.get('GoVersion')!r}")

sdk = next(
    (item for item in modules if item.get("Path") == "github.com/LogBrewCo/sdk/go/logbrew"),
    None,
)
if sdk is None:
    raise SystemExit("missing SDK module in go list -m -json all output")
if sdk.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected SDK module version: {sdk.get('Version')!r}")
if sdk.get("Main") is True:
    raise SystemExit("SDK module incorrectly reported as main module")
if sdk.get("Replace") is not None:
    raise SystemExit("unexpected replace data in SDK module graph entry")
if "/pkg/mod/" not in str(sdk.get("Dir", "")) or not str(sdk.get("Dir", "")).endswith("/go/logbrew@v0.1.0"):
    raise SystemExit(f"unexpected SDK module dir in graph output: {sdk.get('Dir')!r}")
if "/pkg/mod/cache/download/" not in str(sdk.get("GoMod", "")) or not str(sdk.get("GoMod", "")).endswith("/@v/v0.1.0.mod"):
    raise SystemExit(f"unexpected SDK module go.mod path in graph output: {sdk.get('GoMod')!r}")
if sdk.get("GoVersion") != "1.24.0":
    raise SystemExit(f"unexpected SDK module Go version in graph output: {sdk.get('GoVersion')!r}")
PY
make smoke-build >/dev/null
go version -m smoke-app-bin > binary-version.txt
grep -q $'^smoke-app-bin:' binary-version.txt
grep -q $'^\tpath\tsmoke-app$' binary-version.txt
grep -q $'^\tmod\tsmoke-app\t(devel)\t$' binary-version.txt
grep -q $'^\tdep\tgithub.com/LogBrewCo/sdk/go/logbrew\tv0.1.0\th1:' binary-version.txt
make smoke-test >/dev/null
make smoke-vet >/dev/null
GOFLAGS=-mod=readonly go list -m -json github.com/LogBrewCo/sdk/go/logbrew > sdk-module.json
python3 - <<'PY'
import json
from pathlib import Path

payload = json.loads(Path("sdk-module.json").read_text())
if payload.get("Path") != "github.com/LogBrewCo/sdk/go/logbrew":
    raise SystemExit("unexpected Go module path")
if payload.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected Go module version: {payload.get('Version')}")
if payload.get("Replace") is not None:
    raise SystemExit("unexpected Go module replace data")
module_dir = str(payload.get("Dir", ""))
if "/pkg/mod/" not in module_dir or not module_dir.endswith("/go/logbrew@v0.1.0"):
    raise SystemExit(f"unexpected installed Go module dir: {module_dir}")
readme_path = Path(module_dir) / "README.md"
if not readme_path.is_file():
    raise SystemExit(f"missing installed Go module README: {readme_path}")
readme = readme_path.read_text()
for needle in (
    "go get github.com/LogBrewCo/sdk/go/logbrew",
    "LOGBREW_API_KEY",
    "PreviewJSON",
    "ParseTraceparent",
    "CreateTraceparent",
    "SpanAttributesFromTraceparent",
    "NewTraceContext",
    "LogBrewTraceFromContext",
    "LogAttributesWithTrace",
    "IssueAttributesWithTrace",
    "NewHTTPHandler",
    "NewSlogHandler",
    "DatabaseOperationWithLogBrewSpan",
    "SQLQueryContextWithLogBrewSpan",
    "SQLExecContextWithLogBrewSpan",
    "SQLStatementQueryContextRunner",
    "SQLStatementExecContextRunner",
    "CacheOperationWithLogBrewSpan",
    "QueueOperationWithLogBrewSpan",
    "CreateProductActionAttributes",
    "CreateNetworkMilestoneAttributes",
    "HTTPTransport",
    "NewHTTPTransport",
    "examples/agent_timeline",
    "examples/http_trace_correlation",
    "copyable snippets",
    "your own Go service",
):
    if needle not in readme:
        raise SystemExit(f"missing installed Go README guidance: {needle}")
go_mod = str(payload.get("GoMod", ""))
if "/pkg/mod/cache/download/" not in go_mod or not go_mod.endswith("/@v/v0.1.0.mod"):
    raise SystemExit(f"unexpected cached Go module file: {go_mod}")
PY
make smoke-readme > readme-example.stdout.json 2> readme-example.stderr.json
grep -q '"type": "release"' readme-example.stdout.json
grep -q '"type": "environment"' readme-example.stdout.json
grep -q '"type": "issue"' readme-example.stdout.json
grep -q '"type": "log"' readme-example.stdout.json
grep -q '"type": "span"' readme-example.stdout.json
grep -q '"type": "action"' readme-example.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" readme-example.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" readme-example.stdout.json >/dev/null
grep -q '"events":6' readme-example.stderr.json
grep -q '"ok":true' readme-example.stderr.json
make smoke-traceparent > traceparent.stdout.json
grep -q '"ok":true' traceparent.stdout.json
grep -q '"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"' traceparent.stdout.json
grep -q '"parentSpanId":"00f067aa0ba902b7"' traceparent.stdout.json
grep -q '"spanId":"b7ad6b7169203331"' traceparent.stdout.json
grep -q '"traceFlags":"01"' traceparent.stdout.json
grep -q '"sampled":true' traceparent.stdout.json
grep -q '"created":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"' traceparent.stdout.json
grep -q '"durationMs":8.5' traceparent.stdout.json
grep -q '"hasNested":false' traceparent.stdout.json
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew > package-doc.txt
grep -q '^package logbrew' package-doc.txt
grep -q 'provides a small public client for building, validating,' package-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.NewClient > constructor-doc.txt
grep -q '^func NewClient(config Config) (\*Client, error)$' constructor-doc.txt
grep -q 'creates a public LogBrew client from user-supplied SDK identity' constructor-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Config > config-doc.txt
grep -q '^type Config struct {' config-doc.txt
grep -q 'describes the public SDK identity, API key, and retry behavior' config-doc.txt
grep -q 'APIKey is the public LogBrew API key sent to the transport' config-doc.txt
grep -q 'SDKName identifies the calling SDK or application in emitted payloads' config-doc.txt
grep -q 'SDKVersion identifies the calling SDK or application version' config-doc.txt
grep -q 'MaxRetries sets the retry budget for retryable transport failures' config-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Event > event-doc.txt
grep -q '^type Event struct {' event-doc.txt
grep -q 'Event is the public event shape buffered, previewed, and flushed by the' event-doc.txt
grep -q 'client' event-doc.txt
grep -q 'Type is the stable LogBrew event type such as release or span' event-doc.txt
grep -q 'Timestamp is the RFC 3339 event timestamp with timezone information' event-doc.txt
grep -q 'ID is the caller-supplied stable identifier for the event' event-doc.txt
grep -q 'Attributes contains the event payload fields for the given event type' event-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.ReleaseAttributes > release-attributes-doc.txt
grep -q '^type ReleaseAttributes struct {' release-attributes-doc.txt
grep -q 'ReleaseAttributes describes the public payload fields for a release' release-attributes-doc.txt
grep -q 'event' release-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.EnvironmentAttributes > environment-attributes-doc.txt
grep -q '^type EnvironmentAttributes struct {' environment-attributes-doc.txt
grep -q 'EnvironmentAttributes describes the public payload fields for an' environment-attributes-doc.txt
grep -q 'environment' environment-attributes-doc.txt
grep -q 'event' environment-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.IssueAttributes > issue-attributes-doc.txt
grep -q '^type IssueAttributes struct {' issue-attributes-doc.txt
grep -q 'IssueAttributes describes the public payload fields for an issue' issue-attributes-doc.txt
grep -q 'event' issue-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.LogAttributes > log-attributes-doc.txt
grep -q '^type LogAttributes struct {' log-attributes-doc.txt
grep -q 'LogAttributes describes the public payload fields for a log' log-attributes-doc.txt
grep -q 'event' log-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SpanAttributes > span-attributes-doc.txt
grep -q '^type SpanAttributes struct {' span-attributes-doc.txt
grep -q 'SpanAttributes describes the public payload fields for a span' span-attributes-doc.txt
grep -q 'event' span-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.MetricAttributes > metric-attributes-doc.txt
grep -q '^type MetricAttributes struct {' metric-attributes-doc.txt
grep -q 'MetricAttributes describes the public payload fields for an explicit metric' metric-attributes-doc.txt
grep -q 'event' metric-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.DatabaseOperationConfig > database-operation-config-doc.txt
grep -q '^type DatabaseOperationConfig struct {' database-operation-config-doc.txt
grep -q 'DatabaseOperationConfig configures an explicit app-owned database span' database-operation-config-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.CacheOperationConfig > cache-operation-config-doc.txt
grep -q '^type CacheOperationConfig struct {' cache-operation-config-doc.txt
grep -q 'CacheOperationConfig configures an explicit app-owned cache span' cache-operation-config-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.QueueOperationConfig > queue-operation-config-doc.txt
grep -q '^type QueueOperationConfig struct {' queue-operation-config-doc.txt
grep -q 'QueueOperationConfig configures an explicit app-owned queue span' queue-operation-config-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.DatabaseOperationWithLogBrewSpan > database-operation-doc.txt
grep -q '^func DatabaseOperationWithLogBrewSpan' database-operation-doc.txt
grep -q 'queues one privacy-bounded database span' database-operation-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLQueryContextWithLogBrewSpan > sql-query-operation-doc.txt
grep -q '^func SQLQueryContextWithLogBrewSpan' sql-query-operation-doc.txt
grep -q 'Query-text runners receive query text and args' sql-query-operation-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLExecContextWithLogBrewSpan > sql-exec-operation-doc.txt
grep -q '^func SQLExecContextWithLogBrewSpan' sql-exec-operation-doc.txt
grep -q 'Query-text runners receive query text and args' sql-exec-operation-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLQueryContextRunner > sql-query-runner-doc.txt
grep -q '^type SQLQueryContextRunner interface' sql-query-runner-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLStatementQueryContextRunner > sql-statement-query-runner-doc.txt
grep -q '^type SQLStatementQueryContextRunner interface' sql-statement-query-runner-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLExecContextRunner > sql-exec-runner-doc.txt
grep -q '^type SQLExecContextRunner interface' sql-exec-runner-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SQLStatementExecContextRunner > sql-statement-exec-runner-doc.txt
grep -q '^type SQLStatementExecContextRunner interface' sql-statement-exec-runner-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.CacheOperationWithLogBrewSpan > cache-operation-doc.txt
grep -q '^func CacheOperationWithLogBrewSpan' cache-operation-doc.txt
grep -q 'queues one privacy-bounded cache span' cache-operation-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.QueueOperationWithLogBrewSpan > queue-operation-doc.txt
grep -q '^func QueueOperationWithLogBrewSpan' queue-operation-doc.txt
grep -q 'queues one privacy-bounded queue span' queue-operation-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.TraceparentContext > traceparent-context-doc.txt
grep -q '^type TraceparentContext struct {' traceparent-context-doc.txt
grep -q 'TraceparentContext describes an incoming W3C traceparent header after' traceparent-context-doc.txt
grep -q 'validation and normalization' traceparent-context-doc.txt
grep -q 'Sampled reports whether the W3C sampled flag is set' traceparent-context-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.TraceparentSpanInput > traceparent-span-input-doc.txt
grep -q '^type TraceparentSpanInput struct {' traceparent-span-input-doc.txt
grep -q 'TraceparentSpanInput describes a LogBrew span derived from an incoming W3C' traceparent-span-input-doc.txt
grep -q 'traceparent header' traceparent-span-input-doc.txt
grep -q 'Metadata is copied with primitive values only' traceparent-span-input-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.ParseTraceparent > parse-traceparent-doc.txt
grep -q '^func ParseTraceparent(traceparent string) (TraceparentContext, error)$' parse-traceparent-doc.txt
grep -q 'ParseTraceparent validates and normalizes a W3C traceparent header' parse-traceparent-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.CreateTraceparent > create-traceparent-doc.txt
grep -q '^func CreateTraceparent(traceID, spanID, traceFlags string) (string, error)$' create-traceparent-doc.txt
grep -q 'CreateTraceparent creates a normalized W3C traceparent header from explicit' create-traceparent-doc.txt
grep -q 'trace, span, and flags values' create-traceparent-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SpanAttributesFromTraceparent > span-from-traceparent-doc.txt
grep -q '^func SpanAttributesFromTraceparent(input TraceparentSpanInput) (SpanAttributes, error)$' span-from-traceparent-doc.txt
grep -q 'SpanAttributesFromTraceparent returns LogBrew span attributes that continue' span-from-traceparent-doc.txt
grep -q 'an incoming W3C traceparent as a child span' span-from-traceparent-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.ActionAttributes > action-attributes-doc.txt
grep -q '^type ActionAttributes struct {' action-attributes-doc.txt
grep -q 'ActionAttributes describes the public payload fields for an action' action-attributes-doc.txt
grep -q 'event' action-attributes-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.ProductActionInput > product-action-input-doc.txt
grep -q '^type ProductActionInput struct {' product-action-input-doc.txt
grep -q 'ProductActionInput describes an app-owned product step that should be' product-action-input-doc.txt
grep -q 'captured as an agent-readable action event' product-action-input-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.NetworkMilestoneInput > network-milestone-input-doc.txt
grep -q '^type NetworkMilestoneInput struct {' network-milestone-input-doc.txt
grep -q 'NetworkMilestoneInput describes an app-owned API milestone that should be' network-milestone-input-doc.txt
grep -q 'captured as an agent-readable action event' network-milestone-input-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.CreateProductActionAttributes > create-product-action-doc.txt
grep -q '^func CreateProductActionAttributes(input ProductActionInput) (ActionAttributes, error)$' create-product-action-doc.txt
grep -q 'CreateProductActionAttributes builds privacy-safe action attributes for a' create-product-action-doc.txt
grep -q 'product milestone without automatic click capture or global app mutation' create-product-action-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.CreateNetworkMilestoneAttributes > create-network-milestone-doc.txt
grep -q '^func CreateNetworkMilestoneAttributes(input NetworkMilestoneInput) (ActionAttributes, error)$' create-network-milestone-doc.txt
grep -q 'CreateNetworkMilestoneAttributes builds privacy-safe action attributes' create-network-milestone-doc.txt
grep -q 'for an API milestone without patching HTTP clients or capturing' create-network-milestone-doc.txt
grep -q 'payloads/headers' create-network-milestone-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.SdkError > sdk-error-doc.txt
grep -q '^type SdkError struct {' sdk-error-doc.txt
grep -q 'SdkError describes a stable public SDK failure with parseable code' sdk-error-doc.txt
grep -q 'and' sdk-error-doc.txt
grep -q 'message fields' sdk-error-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.TransportResponse > response-doc.txt
grep -q '^type TransportResponse struct {' response-doc.txt
grep -q 'TransportResponse is returned after a transport accepts or skips a queued' response-doc.txt
grep -q 'flush' response-doc.txt
grep -q 'StatusCode is the final HTTP-like status returned by the transport' response-doc.txt
grep -q 'Attempts is the number of transport attempts used for the flush' response-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Transport > transport-interface-doc.txt
grep -q '^type Transport interface {' transport-interface-doc.txt
grep -q 'Transport is the public interface used by Flush and Shutdown transport' transport-interface-doc.txt
grep -q 'calls' transport-interface-doc.txt
grep -q 'Send(apiKey string, body \[\]byte) (\*TransportResponse, error)' transport-interface-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.TransportError > transport-error-doc.txt
grep -q '^type TransportError struct {' transport-error-doc.txt
grep -q 'TransportError describes a transport-layer failure with a stable public code' transport-error-doc.txt
grep -q 'and retry hint' transport-error-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.NetworkError > network-error-doc.txt
grep -q '^func NetworkError(message string) \*TransportError$' network-error-doc.txt
grep -q 'NetworkError creates a retryable network failure that preserves queued' network-error-doc.txt
grep -q 'events' network-error-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.DefaultHTTPEndpoint > http-endpoint-doc.txt
grep -Fq 'DefaultHTTPEndpoint = "https://api.logbrew.com/v1/events"' http-endpoint-doc.txt
grep -q 'DefaultHTTPEndpoint is the production LogBrew event intake URL used by' http-endpoint-doc.txt
grep -q 'NewHTTPTransport when no endpoint is supplied' http-endpoint-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.HTTPTransportConfig > http-config-doc.txt
grep -q '^type HTTPTransportConfig struct {' http-config-doc.txt
grep -q 'HTTPTransportConfig configures the dependency-free HTTP transport' http-config-doc.txt
grep -q 'Endpoint is the URL that receives serialized LogBrew event batches' http-config-doc.txt
grep -q 'Headers are added to every HTTP delivery request after default headers' http-config-doc.txt
grep -Fq 'Client sends requests. When nil, Send uses a shared default client unless' http-config-doc.txt
grep -Fq 'Timeout asks NewHTTPTransport to create one.' http-config-doc.txt
grep -q 'Timeout' http-config-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.HTTPTransport > http-transport-doc.txt
grep -q '^type HTTPTransport struct {' http-transport-doc.txt
grep -q "HTTPTransport sends queued batches through Go's standard net/http client" http-transport-doc.txt
grep -q 'Client sends requests. When nil, a shared default client is used' http-transport-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.NewHTTPTransport > new-http-transport-doc.txt
grep -q '^func NewHTTPTransport(config HTTPTransportConfig) (\*HTTPTransport, error)$' new-http-transport-doc.txt
grep -q 'NewHTTPTransport creates a dependency-free HTTP transport with safe' new-http-transport-doc.txt
grep -q 'defaults' new-http-transport-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.HTTPTransport.Send > http-send-doc.txt
grep -Fq 'func (t *HTTPTransport) Send(apiKey string, body []byte) (*TransportResponse, error)' http-send-doc.txt
grep -q 'Send posts one serialized event batch and returns the HTTP status' http-send-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.RecordingTransport > transport-doc.txt
grep -q '^type RecordingTransport struct {' transport-doc.txt
grep -q 'RecordingTransport scripts transport outcomes for previewing, accepting,' transport-doc.txt
grep -q 'or failing queued event flushes in tests and local runs' transport-doc.txt
grep -q 'SentBodies records every request body sent through this transport' transport-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.RecordingTransport.LastBody > last-body-doc.txt
grep -Fq 'func (t *RecordingTransport) LastBody() []byte' last-body-doc.txt
grep -q 'LastBody returns the most recent request body sent through this' last-body-doc.txt
grep -q 'transport' last-body-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.AlwaysAcceptTransport > accept-doc.txt
grep -q '^func AlwaysAcceptTransport() \*RecordingTransport$' accept-doc.txt
grep -q 'AlwaysAcceptTransport creates a transport that accepts every queued flush' accept-doc.txt
grep -q 'request with a 202 response' accept-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.AsTransportError > as-transport-error-doc.txt
grep -q '^func AsTransportError(err error, target \*\*TransportError) bool$' as-transport-error-doc.txt
grep -q 'AsTransportError extracts a public transport failure for retry-aware' as-transport-error-doc.txt
grep -q 'callers' as-transport-error-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Client.PendingEvents > pending-doc.txt
grep -Fq 'func (c *Client) PendingEvents() int' pending-doc.txt
grep -q 'PendingEvents returns the number of validated events currently buffered' pending-doc.txt
grep -q 'in' pending-doc.txt
grep -q 'memory' pending-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Client.PreviewJSON > preview-doc.txt
grep -Fq 'func (c *Client) PreviewJSON() (string, error)' preview-doc.txt
grep -q 'PreviewJSON returns the queued event batch as stable, pretty-printed JSON' preview-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Client.Flush > flush-doc.txt
grep -Fq 'func (c *Client) Flush(transport Transport) (*TransportResponse, error)' flush-doc.txt
grep -q 'Flush sends queued events through a transport while preserving retry' flush-doc.txt
grep -q 'semantics' flush-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Client.Shutdown > shutdown-doc.txt
grep -Fq 'func (c *Client) Shutdown(transport Transport) (*TransportResponse, error)' shutdown-doc.txt
grep -q 'Shutdown flushes queued events, then marks the client closed so later' shutdown-doc.txt
grep -q 'writes' shutdown-doc.txt
grep -q 'fail' shutdown-doc.txt
GOFLAGS=-mod=readonly go doc github.com/LogBrewCo/sdk/go/logbrew.Client.Metric > metric-doc.txt
grep -Fq 'func (c *Client) Metric(id, timestamp string, attributes MetricAttributes) error' metric-doc.txt
grep -q 'Metric queues an explicit, application-owned metric event after validating' metric-doc.txt
grep -q 'name, kind, value, unit, temporality, and optional metadata' metric-doc.txt
GOFLAGS=-mod=readonly go list -deps -json ./... > dependency-list.json
python3 - <<'PY'
import json
from pathlib import Path

decoder = json.JSONDecoder()
payload = Path("dependency-list.json").read_text()
index = 0
packages = []
while index < len(payload):
    while index < len(payload) and payload[index].isspace():
        index += 1
    if index >= len(payload):
        break
    item, next_index = decoder.raw_decode(payload, index)
    packages.append(item)
    index = next_index

root = next((item for item in packages if item.get("ImportPath") == "smoke-app"), None)
if root is None:
    raise SystemExit("missing root package in go list -deps -json output")
if root.get("Name") != "main":
    raise SystemExit(f"unexpected root package name: {root.get('Name')!r}")
if str(root.get("Dir", "")).endswith("/smoke-app") is False:
    raise SystemExit(f"unexpected root package dir: {root.get('Dir')!r}")
if "github.com/LogBrewCo/sdk/go/logbrew" not in root.get("Deps", []):
    raise SystemExit("root package deps missing installed SDK package")

sdk = next(
    (item for item in packages if item.get("ImportPath") == "github.com/LogBrewCo/sdk/go/logbrew"),
    None,
)
if sdk is None:
    raise SystemExit("missing SDK package in go list -deps -json output")
if sdk.get("Name") != "logbrew":
    raise SystemExit(f"unexpected SDK package name: {sdk.get('Name')!r}")
if sdk.get("Standard") is True:
    raise SystemExit("SDK package incorrectly reported as a standard-library package")
module = sdk.get("Module") or {}
if module.get("Path") != "github.com/LogBrewCo/sdk/go/logbrew":
    raise SystemExit(f"unexpected SDK package module path: {module.get('Path')!r}")
if module.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected SDK package module version: {module.get('Version')!r}")
if module.get("Main") is True:
    raise SystemExit("SDK package module incorrectly reported as main module")
if module.get("Replace") is not None:
    raise SystemExit("unexpected replace data in SDK package module metadata")
sdk_dir = str(sdk.get("Dir", ""))
if "/pkg/mod/" not in sdk_dir or not sdk_dir.endswith("/go/logbrew@v0.1.0"):
    raise SystemExit(f"unexpected SDK package dir in dependency output: {sdk_dir!r}")
go_files = sdk.get("GoFiles") or []
if "logbrew.go" not in go_files:
    raise SystemExit(f"unexpected SDK package Go files: {go_files!r}")
PY

make smoke-run > smoke.stdout.json 2> smoke.stderr.json
grep -q '"type": "release"' smoke.stdout.json
grep -q '"type": "environment"' smoke.stdout.json
grep -q '"type": "issue"' smoke.stdout.json
grep -q '"type": "log"' smoke.stdout.json
grep -q '"type": "span"' smoke.stdout.json
grep -q '"type": "action"' smoke.stdout.json
python3 "$repo_root/scripts/validate_fixtures.py" smoke.stdout.json >/dev/null
python3 "$repo_root/scripts/check_sdk_parity.py" "$repo_root/fixtures/valid-batch.json" smoke.stdout.json >/dev/null
grep -q '"events":6' smoke.stderr.json
grep -q '"ok":true' smoke.stderr.json

cat > unauth.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_unauth", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
	}))

	err = mustFlush(client)
	payload := map[string]any{
		"ok":      true,
		"pending": client.PendingEvents(),
	}
	if sdkErr, ok := err.(*logbrew.SdkError); ok {
		payload["code"] = sdkErr.Code
		payload["message"] = sdkErr.Message
	}
	must(json.NewEncoder(os.Stdout).Encode(payload))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func mustFlush(client *logbrew.Client) error {
	_, err := client.Flush(logbrew.NewRecordingTransport([]any{401}))
	if err == nil {
		panic("expected unauthenticated error")
	}
	return err
}
EOF

GOFLAGS=-mod=readonly go run unauth.go > unauth.stdout.json
grep -q '"ok":true' unauth.stdout.json
grep -q '"code":"unauthenticated"' unauth.stdout.json
grep -q '"message":"transport rejected the API key"' unauth.stdout.json
grep -q '"pending":1' unauth.stdout.json

cat > retry.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_retry", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
	}))

	response, err := client.Flush(logbrew.NewRecordingTransport([]any{
		logbrew.NetworkError("temporary outage"),
		202,
	}))
	must(err)
	must(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"pending":  client.PendingEvents(),
	}))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run retry.go > retry.stdout.json
grep -q '"ok":true' retry.stdout.json
grep -q '"status":202' retry.stdout.json
grep -q '"attempts":2' retry.stdout.json
grep -q '"pending":0' retry.stdout.json

cat > http_transport.go <<'EOF'
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

type receivedRequest struct {
	Authorization string
	Body          string
	ContentType   string
	Method        string
	Path          string
	Source        string
}

func main() {
	requests := make([]receivedRequest, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(response, err.Error(), http.StatusBadRequest)
			return
		}
		requests = append(requests, receivedRequest{
			Authorization: request.Header.Get("authorization"),
			Body:          string(body),
			ContentType:   request.Header.Get("content-type"),
			Method:        request.Method,
			Path:          request.URL.Path,
			Source:        request.Header.Get("x-logbrew-source"),
		})
		if len(requests) == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app-http",
		SDKVersion: "0.1.0",
		MaxRetries: 1,
	})
	must(err)
	must(client.Log("evt_go_http_transport", "2026-06-02T10:00:06Z", logbrew.LogAttributes{
		Message: "delivery retry",
		Level:   "info",
		Logger:  "worker",
	}))

	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{
		Endpoint: server.URL + "/v1/events",
		Headers:  map[string]string{"x-logbrew-source": "go-smoke"},
		Client:   server.Client(),
	})
	must(err)
	response, err := client.Flush(transport)
	must(err)
	if len(requests) != 2 {
		panic(fmt.Sprintf("expected two HTTP requests, got %d", len(requests)))
	}
	first := requests[0]
	last := requests[len(requests)-1]
	if first.Body != last.Body {
		panic("expected retry body to stay unchanged")
	}
	if last.Authorization != "Bearer LOGBREW_API_KEY" {
		panic("expected authorization header")
	}
	if last.ContentType != "application/json" {
		panic("expected JSON content type")
	}
	if last.Method != http.MethodPost {
		panic("expected POST method")
	}
	if last.Path != "/v1/events" {
		panic("expected intake path")
	}
	if last.Source != "go-smoke" {
		panic("expected custom source header")
	}

	var posted struct {
		Events []struct {
			ID string `json:"id"`
		} `json:"events"`
	}
	must(json.Unmarshal([]byte(last.Body), &posted))
	if len(posted.Events) != 1 || posted.Events[0].ID != "evt_go_http_transport" {
		panic("expected HTTP transport event")
	}

	must(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"authorization": last.Authorization,
		"httpAttempts":  response.Attempts,
		"httpEvents":    len(posted.Events),
		"method":        last.Method,
		"ok":            true,
		"path":          last.Path,
		"pending":       client.PendingEvents(),
		"requestCount":  len(requests),
		"source":        last.Source,
		"status":        response.StatusCode,
	}))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run http_transport.go > http_transport.stdout.json
grep -q '"ok":true' http_transport.stdout.json
grep -q '"status":202' http_transport.stdout.json
grep -q '"httpAttempts":2' http_transport.stdout.json
grep -q '"httpEvents":1' http_transport.stdout.json
grep -q '"pending":0' http_transport.stdout.json
grep -q '"requestCount":2' http_transport.stdout.json
grep -q '"authorization":"Bearer LOGBREW_API_KEY"' http_transport.stdout.json
grep -q '"source":"go-smoke"' http_transport.stdout.json
grep -q '"method":"POST"' http_transport.stdout.json
grep -q '"path":"/v1/events"' http_transport.stdout.json

cat > shutdown.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_shutdown", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
	}))

	_, err = client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	err = client.Log("evt_log_shutdown", "2026-06-02T10:00:01Z", logbrew.LogAttributes{
		Message: "should fail",
		Level:   "info",
	})
	if err == nil {
		panic("expected shutdown error")
	}
	payload := map[string]any{
		"ok":      true,
		"pending": client.PendingEvents(),
	}
	if sdkErr, ok := err.(*logbrew.SdkError); ok {
		payload["code"] = sdkErr.Code
		payload["message"] = sdkErr.Message
	}
	must(json.NewEncoder(os.Stdout).Encode(payload))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run shutdown.go > shutdown.stdout.json
grep -q '"ok":true' shutdown.stdout.json
grep -q '"code":"shutdown_error"' shutdown.stdout.json
grep -q '"message":"client is already shut down"' shutdown.stdout.json
grep -q '"pending":0' shutdown.stdout.json

cat > empty_flush.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	response, err := client.Flush(logbrew.AlwaysAcceptTransport())
	must(err)
	must(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"pending":  client.PendingEvents(),
	}))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run empty_flush.go > empty_flush.stdout.json
grep -q '"ok":true' empty_flush.stdout.json
grep -q '"status":204' empty_flush.stdout.json
grep -q '"attempts":0' empty_flush.stdout.json
grep -q '"pending":0' empty_flush.stdout.json

cat > validation.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	err = client.Log("evt_log_invalid", "2026-06-02T10:00:03", logbrew.LogAttributes{
		Message: "should fail",
		Level:   "info",
	})
	if err == nil {
		panic("expected validation error")
	}
	payload := map[string]any{
		"ok":      true,
		"pending": client.PendingEvents(),
	}
	if sdkErr, ok := err.(*logbrew.SdkError); ok {
		payload["code"] = sdkErr.Code
		payload["message"] = sdkErr.Message
	}
	must(json.NewEncoder(os.Stdout).Encode(payload))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run validation.go > validation.stdout.json
grep -q '"ok":true' validation.stdout.json
grep -q '"code":"validation_error"' validation.stdout.json
grep -q '"message":"timestamp must include a timezone offset: 2026-06-02T10:00:03"' validation.stdout.json
grep -q '"pending":0' validation.stdout.json

cat > retry_budget.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_retry_budget", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
	}))

	_, err = client.Flush(logbrew.NewRecordingTransport([]any{
		logbrew.NetworkError("temporary outage"),
		logbrew.NetworkError("temporary outage"),
		logbrew.NetworkError("temporary outage"),
	}))
	if err == nil {
		panic("expected network failure")
	}
	payload := map[string]any{
		"ok":      true,
		"pending": client.PendingEvents(),
	}
	if sdkErr, ok := err.(*logbrew.SdkError); ok {
		payload["code"] = sdkErr.Code
		payload["message"] = sdkErr.Message
	}
	must(json.NewEncoder(os.Stdout).Encode(payload))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run retry_budget.go > retry_budget.stdout.json
grep -q '"ok":true' retry_budget.stdout.json
grep -q '"code":"network_failure"' retry_budget.stdout.json
grep -q '"message":"temporary outage"' retry_budget.stdout.json
grep -q '"pending":1' retry_budget.stdout.json

cat > transport_status.go <<'EOF'
package main

import (
	"encoding/json"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "smoke-app",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_transport_status", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
	}))

	_, err = client.Flush(logbrew.NewRecordingTransport([]any{400}))
	if err == nil {
		panic("expected transport error")
	}
	payload := map[string]any{
		"ok":      true,
		"pending": client.PendingEvents(),
	}
	if sdkErr, ok := err.(*logbrew.SdkError); ok {
		payload["code"] = sdkErr.Code
		payload["message"] = sdkErr.Message
	}
	must(json.NewEncoder(os.Stdout).Encode(payload))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
EOF

GOFLAGS=-mod=readonly go run transport_status.go > transport-status.stdout.json
grep -q '"ok":true' transport-status.stdout.json
grep -q '"code":"transport_error"' transport-status.stdout.json
grep -q '"message":"unexpected transport status 400"' transport-status.stdout.json
grep -q '"pending":1' transport-status.stdout.json
