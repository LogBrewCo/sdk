#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

dist_dir="$tmp_dir/dist"
mkdir -p "$dist_dir"

printf 'console.log("compiled app");//# sourceMappingURL=app.js.map\n' > "$dist_dir/app.js"
python3 - "$dist_dir/app.js.map" <<'PY'
import json
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(
    json.dumps(
        {
            "version": 3,
            "file": "app.js",
            "sources": ["src/app.ts"],
            "sourcesContent": ["console.log('source line should stay local')"],
            "names": [],
            "mappings": "AAAA",
        }
    ),
    encoding="utf-8",
)
PY

debug_plan_dry_run="$tmp_dir/debug-plan-dry-run.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  > "$debug_plan_dry_run"

python3 - "$debug_plan_dry_run" "$dist_dir/app.js" <<'PY'
import json
import re
import sys
from pathlib import Path

plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
js_source = Path(sys.argv[2]).read_text(encoding="utf-8")
artifact = plan["artifacts"][0]

assert plan["validation"]["status"] == "ready"
assert plan["writeApplied"] is False
assert artifact["changes"] == ["minifiedSource.debugId", "sourceMap.debug_id"]
assert re.match(r"^[0-9a-f-]{36}$", artifact["debugId"])
assert "debugId=" not in js_source
PY

debug_plan_written="$tmp_dir/debug-plan-written.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  --write \
  > "$debug_plan_written"

debug_plan_idempotent="$tmp_dir/debug-plan-idempotent.json"
python3 "$repo_root/scripts/prepare_js_release_artifact_debug_ids.py" \
  --build-dir "$dist_dir" \
  > "$debug_plan_idempotent"

python3 - "$debug_plan_written" "$debug_plan_idempotent" "$dist_dir/app.js" "$dist_dir/app.js.map" <<'PY'
import json
import sys
from pathlib import Path

written = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
idempotent = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
js_lines = Path(sys.argv[3]).read_text(encoding="utf-8").splitlines()
source_map = json.loads(Path(sys.argv[4]).read_text(encoding="utf-8"))
debug_id = written["artifacts"][0]["debugId"]

assert written["validation"]["status"] == "ready"
assert written["writeApplied"] is True
assert idempotent["validation"]["status"] == "ready"
assert idempotent["writeApplied"] is False
assert idempotent["artifacts"][0]["changes"] == []
assert idempotent["artifacts"][0]["debugId"] == debug_id
assert js_lines[0] == 'console.log("compiled app");'
assert js_lines[1] == f"//# debugId={debug_id}"
assert js_lines[2] == "//# sourceMappingURL=app.js.map"
assert source_map["debug_id"] == debug_id
PY

blocked_manifest="$tmp_dir/manifest-blocked.json"
if python3 "$repo_root/scripts/create_js_release_artifact_manifest.py" \
  --build-dir "$dist_dir" \
  --release "2026.06.13" \
  --environment "production" \
  --service "checkout-web" \
  --minified-path-prefix "https://cdn.example/assets?cache=placeholder#app" \
  > "$blocked_manifest"; then
  echo "manifest unexpectedly allowed sourcesContent without opt-in" >&2
  exit 1
fi

ready_manifest="$tmp_dir/manifest-ready.json"
python3 "$repo_root/scripts/create_js_release_artifact_manifest.py" \
  --build-dir "$dist_dir" \
  --release "2026.06.13" \
  --environment "production" \
  --service "checkout-web" \
  --minified-path-prefix "https://cdn.example/assets?cache=placeholder#app" \
  --allow-sources-content \
  > "$ready_manifest"

python3 - "$blocked_manifest" "$ready_manifest" <<'PY'
import json
import sys
from pathlib import Path

blocked = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
ready = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
serialized_ready = json.dumps(ready)

assert blocked["validation"]["status"] == "blocked"
assert any("sourcesContent" in error for error in blocked["validation"]["errors"])
assert ready["validation"]["status"] == "ready"
assert ready["artifacts"][0]["sourceMap"]["hasSourcesContent"] is True
assert ready["artifacts"][0]["minifiedSource"]["minifiedUrl"] == "https://cdn.example/assets/app.js"
assert "source line should stay local" not in serialized_ready
assert "cache=placeholder" not in serialized_ready
PY

printf '%s\n' "real-user JavaScript release artifact smoke ok"
