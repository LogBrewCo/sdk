#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
export PYTHONDONTWRITEBYTECODE=1

cleanup() {
  rm -rf "$tmp_dir"
}

trap cleanup EXIT

app_root="$tmp_dir/react-native-checkout"
android_mapping="$app_root/android/app/build/outputs/mapping/release/mapping.txt"
android_symbols_dir="$app_root/android/app/build/intermediates/merged_native_libs/release/out/lib/arm64-v8a"
android_so="$android_symbols_dir/libreactnativecheckout.so"
dsym_dir="$app_root/ios/build/ReactNativeCheckout.xcarchive/dSYMs/ReactNativeCheckout.app.dSYM"
dwarf_dir="$dsym_dir/Contents/Resources/DWARF"
ios_dwarf="$dwarf_dir/ReactNativeCheckout"
dsym_archive="$app_root/ios/build/ReactNativeCheckout.dSYMs.zip"

mkdir -p "$(dirname "$android_mapping")" "$android_symbols_dir" "$dwarf_dir" "$(dirname "$dsym_archive")"
printf '%s\n' '<plist version="1.0" />' > "$dsym_dir/Contents/Info.plist"
printf '%s\n' \
  'com.logbrew.checkout.ReactNativeCheckout -> a:' \
  '    void placeOrder(java.lang.String itemId) -> a' \
  > "$android_mapping"

PYTHONPATH="$repo_root/tests" python3 - "$ios_dwarf" "$android_so" "$dsym_archive" <<'PY'
import sys
import zipfile
from pathlib import Path

from native_elf_fixture import write_android_elf_symbol
from native_macho_fixture import write_macho_dwarf

ios_dwarf = Path(sys.argv[1])
android_so = Path(sys.argv[2])
dsym_archive = Path(sys.argv[3])

write_macho_dwarf(ios_dwarf)
write_android_elf_symbol(android_so)

with zipfile.ZipFile(dsym_archive, "w") as archive:
    archive.write(
        ios_dwarf,
        "ReactNativeCheckout.app.dSYM/Contents/Resources/DWARF/ReactNativeCheckout",
    )
    archive.write(
        ios_dwarf.parents[2] / "Info.plist",
        "ReactNativeCheckout.app.dSYM/Contents/Info.plist",
    )
PY

manifest="$tmp_dir/react-native-native-manifest.json"
python3 "$repo_root/scripts/create_native_release_artifact_manifest.py" \
  --artifact-root "$app_root" \
  --release "2026.06.22-react-native-native" \
  --environment "production" \
  --service "checkout-react-native" \
  --artifact "ios_dsym=$dsym_archive" \
  --artifact "android_proguard_mapping=$android_mapping" \
  --artifact "android_native_symbols=$android_symbols_dir" \
  > "$manifest"

python3 - "$manifest" "$tmp_dir" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
tmp_dir = sys.argv[2]
serialized = json.dumps(manifest)
artifact_types = [artifact["artifactType"] for artifact in manifest["artifacts"]]

assert manifest["validation"]["status"] == "ready"
assert manifest["release"] == "2026.06.22-react-native-native"
assert manifest["environment"] == "production"
assert manifest["service"] == "checkout-react-native"
assert artifact_types == ["ios_dsym", "android_proguard_mapping", "android_native_symbols"]

ios_artifact = manifest["artifacts"][0]
android_mapping_artifact = manifest["artifacts"][1]
android_native_artifact = manifest["artifacts"][2]
android_native_file = android_native_artifact["androidNativeSymbols"]["files"][0]

assert ios_artifact["path"] == "ios/build/ReactNativeCheckout.dSYMs.zip"
assert ios_artifact["dsym"]["archiveFormat"] == "zip"
assert ios_artifact["dsym"]["bundleName"] == "ReactNativeCheckout.app.dSYM"
assert ios_artifact["dsym"]["uuidCount"] == 1
assert (
    ios_artifact["dsym"]["dwarfFiles"][0]["path"]
    == "ios/build/ReactNativeCheckout.dSYMs.zip!ReactNativeCheckout.app.dSYM/Contents/Resources/DWARF/ReactNativeCheckout"
)
assert android_mapping_artifact["path"] == "android/app/build/outputs/mapping/release/mapping.txt"
assert android_mapping_artifact["proguard"]["classMappingCount"] == 1
assert (
    android_native_file["path"]
    == "android/app/build/intermediates/merged_native_libs/release/out/lib/arm64-v8a/libreactnativecheckout.so"
)
assert android_native_file["arch"] == "arm64-v8a"
assert android_native_file["elfClass"] == 64
assert android_native_file["elfType"] == "DYN"
assert android_native_file["symbolSource"] == "debug_info"

assert tmp_dir not in serialized
assert "com.logbrew.checkout" not in serialized
assert "placeOrder" not in serialized
assert "java.lang.String" not in serialized
assert "raw-symbol-section" not in serialized
assert "src/app/checkout.cpp" not in serialized
assert "macho-debug-payload" not in serialized
PY

printf '%s\n' "real-user React Native native release artifact smoke ok"
