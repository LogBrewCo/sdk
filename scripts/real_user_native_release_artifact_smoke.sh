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
native_symbols_dir="$artifact_root/android/symbols"
native_so="$native_symbols_dir/lib/arm64-v8a/libcheckout.so"
breakpad_symbols_dir="$artifact_root/native/breakpad"
breakpad_symbol="$breakpad_symbols_dir/checkout.sym"
dotnet_symbols_dir="$artifact_root/windows/symbols"
dotnet_pe="$dotnet_symbols_dir/checkout.dll"
dotnet_pdb="$dotnet_symbols_dir/checkout.pdb"

mkdir -p "$dwarf_dir" "$(dirname "$mapping_file")" "$(dirname "$native_so")" "$breakpad_symbols_dir" "$dotnet_symbols_dir"
printf '%s\n' '<plist version="1.0" />' > "$dsym_dir/Contents/Info.plist"
printf '%s\n' \
  'com.example.Checkout -> a:' \
  '    void placeOrder() -> a' \
  > "$mapping_file"
PYTHONPATH="$repo_root/tests" python3 - "$dwarf_dir/Checkout" "$native_so" "$breakpad_symbol" "$dotnet_pe" "$dotnet_pdb" <<'PY'
import sys
from pathlib import Path

from native_breakpad_fixture import write_breakpad_symbol
from native_elf_fixture import write_android_elf_symbol
from native_macho_fixture import write_macho_dwarf
from native_pe_fixture import write_pdb, write_pe_with_codeview

write_macho_dwarf(Path(sys.argv[1]))
write_android_elf_symbol(Path(sys.argv[2]))
write_breakpad_symbol(Path(sys.argv[3]))
write_pe_with_codeview(Path(sys.argv[4]))
write_pdb(Path(sys.argv[5]))
PY

ready_manifest="$tmp_dir/native-manifest-ready.json"
python3 "$repo_root/scripts/create_native_release_artifact_manifest.py" \
  --artifact-root "$artifact_root" \
  --release "2026.06.17" \
  --environment "production" \
  --service "checkout-mobile" \
  --artifact "ios_dsym=$dsym_dir" \
  --artifact "android_proguard_mapping=$mapping_file" \
  --artifact "android_native_symbols=$native_symbols_dir" \
  --artifact "breakpad_symbols=$breakpad_symbols_dir" \
  --artifact "dotnet_pdb=$dotnet_symbols_dir" \
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
    "android_native_symbols",
    "breakpad_symbols",
    "dotnet_pdb",
]
assert manifest["artifacts"][0]["path"] == "ios/Checkout.app.dSYM"
assert manifest["artifacts"][0]["dsym"]["hasInfoPlist"] is True
assert manifest["artifacts"][0]["dsym"]["uuidCount"] == 1
assert manifest["artifacts"][0]["dsym"]["dwarfFiles"][0]["uuids"] == [
    {"uuid": "C8469F85-B060-3085-B69D-E46C645560EA", "arch": "arm64"}
]
assert manifest["artifacts"][1]["path"] == "android/mapping.txt"
assert manifest["artifacts"][1]["proguard"]["classMappingCount"] == 1
native_details = manifest["artifacts"][2]["androidNativeSymbols"]
native_file = native_details["files"][0]
assert native_details["symbolFileCount"] == 1
assert native_file["path"] == "android/symbols/lib/arm64-v8a/libcheckout.so"
assert native_file["gnuBuildId"] == "32cc7f54d61dc2d4022a4dc58fdec1f4"
assert native_file["symbolSource"] == "debug_info"
breakpad_details = manifest["artifacts"][3]["breakpadSymbols"]
breakpad_file = breakpad_details["files"][0]
assert breakpad_details["symbolFileCount"] == 1
assert breakpad_file["path"] == "native/breakpad/checkout.sym"
assert breakpad_file["guid"] == "00112233-4455-6677-8899-AABBCCDDEEFF"
assert breakpad_file["age"] == 42
assert breakpad_file["symbolSource"] == "debug_info"
dotnet_details = manifest["artifacts"][4]["dotnetPdb"]
dotnet_file = dotnet_details["files"][0]
assert dotnet_details["symbolFileCount"] == 1
assert dotnet_file["path"] == "windows/symbols/checkout.dll"
assert dotnet_file["pdbPath"] == "windows/symbols/checkout.pdb"
assert dotnet_file["pdbGuid"] == "00112233-4455-6677-8899-AABBCCDDEEFF"
assert dotnet_file["pdbAge"] == 42
assert dotnet_file["pdbFileName"] == "checkout.pdb"
assert dotnet_file["symbolSource"] == "debug_info"
assert tmp_dir not in serialized
assert "com.example.Checkout" not in serialized
assert "macho-debug-payload" not in serialized
assert "raw-symbol-section" not in serialized
assert "src/app/checkout.cpp" not in serialized
assert "checkout_handler" not in serialized
assert "C:\\Users\\dev\\checkout.pdb" not in serialized
assert "portable-pdb-symbol-bytes" not in serialized
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
