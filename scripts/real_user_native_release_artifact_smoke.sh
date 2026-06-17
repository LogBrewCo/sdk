#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

artifact_root="$tmp_dir/artifacts"
dsym_dir="$artifact_root/ios/Checkout.app.dSYM"
dwarf_dir="$dsym_dir/Contents/Resources/DWARF"
mapping_file="$artifact_root/android/mapping.txt"

mkdir -p "$dwarf_dir" "$(dirname "$mapping_file")"
printf '%s\n' '<plist version="1.0" />' > "$dsym_dir/Contents/Info.plist"
printf '%s\n' 'fake dwarf object bytes' > "$dwarf_dir/Checkout"
printf '%s\n' \
  'com.example.Checkout -> a:' \
  '    void placeOrder() -> a' \
  > "$mapping_file"

ready_manifest="$tmp_dir/native-manifest-ready.json"
python3 "$repo_root/scripts/create_native_release_artifact_manifest.py" \
  --artifact-root "$artifact_root" \
  --release "2026.06.17" \
  --environment "production" \
  --service "checkout-mobile" \
  --artifact "ios_dsym=$dsym_dir" \
  --artifact "android_proguard_mapping=$mapping_file" \
  > "$ready_manifest"

python3 - "$ready_manifest" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[2]
serialized = json.dumps(manifest)

assert manifest["validation"]["status"] == "ready"
assert manifest["artifactType"] == "native_debug_symbol_manifest"
assert [artifact["artifactType"] for artifact in manifest["artifacts"]] == [
    "ios_dsym",
    "android_proguard_mapping",
]
assert manifest["artifacts"][0]["path"] == "ios/Checkout.app.dSYM"
assert manifest["artifacts"][0]["dsym"]["hasInfoPlist"] is True
assert manifest["artifacts"][1]["path"] == "android/mapping.txt"
assert manifest["artifacts"][1]["proguard"]["classMappingCount"] == 1
assert tmp_dir not in serialized
assert "com.example.Checkout" not in serialized
assert "fake dwarf object bytes" not in serialized
PY

blocked_mapping="$artifact_root/android/empty-mapping.txt"
printf '%s\n' '# compiler: R8' > "$blocked_mapping"
blocked_manifest="$tmp_dir/native-manifest-blocked.json"
if python3 "$repo_root/scripts/create_native_release_artifact_manifest.py" \
  --artifact-root "$artifact_root" \
  --release "2026.06.17" \
  --environment "production" \
  --service "checkout-mobile" \
  --artifact "android_proguard_mapping=$blocked_mapping" \
  > "$blocked_manifest"; then
  echo "native release artifact manifest unexpectedly accepted a mapping without class entries" >&2
  exit 1
fi

python3 - "$blocked_manifest" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))

assert manifest["validation"]["status"] == "blocked"
assert any("no class mapping entries" in error for error in manifest["validation"]["errors"])
PY

printf '%s\n' "real-user native release artifact smoke ok"
