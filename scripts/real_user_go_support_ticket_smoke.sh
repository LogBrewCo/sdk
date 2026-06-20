#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
teardown_tmp_dir() {
	chmod -R u+w "$tmp_dir" 2>/dev/null || true
	rm -rf "$tmp_dir"
}
trap teardown_tmp_dir EXIT

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

export GOPROXY="file://$proxy_dir"
export GOSUMDB=off
app_dir="$tmp_dir/support-smoke-app"
mkdir -p "$app_dir"
cd "$app_dir"
go mod init example.com/logbrew-go-support-smoke >/dev/null
go get github.com/LogBrewCo/sdk/go/logbrew@v0.1.0 >/dev/null

cat > main.go <<'GO'
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	token := strings.Join([]string{"lbw", "ingest", "hidden"}, "_")
	draft, err := logbrew.CreateSupportTicketDraft(logbrew.SupportTicketDraftInput{
		Source:      "sdk",
		Category:    "ingest_failure",
		Title:       "Telemetry flush failed",
		Description: "Flush returned usage_limit_exceeded",
		ProjectID:   "proj_123",
		Environment: "production",
		Runtime:     "go1.25",
		Framework:   "net/http",
		SDKPackage:  "github.com/LogBrewCo/sdk/go/logbrew",
		SDKVersion:  "0.1.0",
		Release:     "checkout@1.2.3",
		TraceID:     "4BF92F3577B34DA6A3CE929D0E0E4736",
		EventID:     "evt_checkout_flush",
		Diagnostics: map[string]any{
			"attemptCount": 2,
			"apiKey":      token,
			"endpoint":    "https://api.example/ingest?debug=true#frag",
			"localPath":   "/Users/example/app/.env",
			"error":       errors.New("contains hidden message"),
			"headers": map[string]any{
				"authorization": strings.Join([]string{"Bearer", "hidden"}, " "),
				"accept":        "application/json",
			},
		},
	})
	if err != nil {
		panic(err)
	}
	payload, err := json.MarshalIndent(draft, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(payload))
}
GO

go run . > "$tmp_dir/support-draft.json"
python3 - "$tmp_dir/support-draft.json" <<'PY'
from pathlib import Path
import json
import sys

payload = json.loads(Path(sys.argv[1]).read_text())
expected = {
    "source": "sdk",
    "category": "ingest_failure",
    "title": "Telemetry flush failed",
    "description": "Flush returned usage_limit_exceeded",
    "project_id": "proj_123",
    "environment": "production",
    "runtime": "go1.25",
    "framework": "net/http",
    "sdk_package": "github.com/LogBrewCo/sdk/go/logbrew",
    "sdk_version": "0.1.0",
    "release": "checkout@1.2.3",
    "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
    "event_id": "evt_checkout_flush",
}
for key, value in expected.items():
    if payload.get(key) != value:
        raise SystemExit(f"unexpected support draft {key}: {payload.get(key)!r}")
diagnostics = payload.get("diagnostics") or {}
if diagnostics.get("apiKey") != "[redacted]":
    raise SystemExit(f"apiKey was not redacted: {diagnostics!r}")
if diagnostics.get("endpoint") != "[redacted-url]/ingest":
    raise SystemExit(f"endpoint was not origin-redacted: {diagnostics!r}")
if diagnostics.get("localPath") != "[redacted-path]":
    raise SystemExit(f"local path was not redacted: {diagnostics!r}")
if (diagnostics.get("error") or {}).get("type") in (None, ""):
    raise SystemExit(f"error type was not retained safely: {diagnostics!r}")
headers = diagnostics.get("headers") or {}
if headers.get("authorization") != "[redacted]" or headers.get("accept") != "application/json":
    raise SystemExit(f"headers were not sanitized: {headers!r}")
text = json.dumps(payload, sort_keys=True)
for unsafe in ("hidden", "api.example", "/Users/example", "traceparent", "contains hidden message"):
    if unsafe in text:
        raise SystemExit(f"support draft leaked {unsafe!r}: {text}")
PY

go doc github.com/LogBrewCo/sdk/go/logbrew CreateSupportTicketDraft > "$tmp_dir/create-support-doc.txt"
go doc github.com/LogBrewCo/sdk/go/logbrew SupportTicketDraftInput > "$tmp_dir/support-input-doc.txt"
go doc github.com/LogBrewCo/sdk/go/logbrew SupportTicketDraft > "$tmp_dir/support-draft-doc.txt"
grep -q "CreateSupportTicketDraft builds a local-only" "$tmp_dir/create-support-doc.txt"
grep -q "type SupportTicketDraftInput struct" "$tmp_dir/support-input-doc.txt"
grep -q "type SupportTicketDraft struct" "$tmp_dir/support-draft-doc.txt"

go list -m -json github.com/LogBrewCo/sdk/go/logbrew > "$tmp_dir/module.json"
python3 - "$tmp_dir/module.json" <<'PY'
from pathlib import Path
import json
import sys

payload = json.loads(Path(sys.argv[1]).read_text())
module_dir = Path(str(payload.get("Dir", "")))
if payload.get("Version") != "v0.1.0":
    raise SystemExit(f"unexpected module version: {payload.get('Version')!r}")
support_source = module_dir / "support_ticket.go"
if not support_source.is_file():
    raise SystemExit(f"missing packaged support_ticket.go: {support_source}")
readme = (module_dir / "README.md").read_text()
for needle in (
    "CreateSupportTicketDraft",
    "SupportTicketDraftInput",
    "support-ticket routes",
    "does not send data, open a ticket",
):
    if needle not in readme:
        raise SystemExit(f"missing README support-ticket guidance: {needle}")
PY

printf '%s\n' "go support ticket installed-artifact smoke ok"
