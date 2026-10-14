#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package_dir="$repo_root/swift/logbrew-swift"
tmp_dir="$(mktemp -d)"
swiftlint_version="0.65.1"
swiftformat_version="0.63.1"
trap 'find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
  Darwin:*)
    swiftlint_asset="portable_swiftlint.zip"; swiftlint_sha256="c1e429b0599cf1b516f369a2d9ec04eaf0e436f3c12b637df8851fa52ff694d0"
    swiftformat_asset="swiftformat.zip"; swiftformat_sha256="385ef1a263ba28685157b98c5536b9c9105e124518f28b7ef8a2bee4b167eaeb"; swiftformat_name="swiftformat"
    ;;
  Linux:x86_64)
    swiftlint_asset="swiftlint_linux_amd64.zip"; swiftlint_sha256="caeed6f4a679c35539ffaf124f6c4ab4a8416917f7d8796279dc52b74026059d"
    swiftformat_asset="swiftformat_linux.zip"; swiftformat_sha256="9e10090e0213378c68cedb42adc2c6461916a9c8e457cf452b5585b84096c333"; swiftformat_name="swiftformat_linux"
    ;;
  Linux:arm64 | Linux:aarch64)
    swiftlint_asset="swiftlint_linux_arm64.zip"; swiftlint_sha256="9ffa52f478e6d8eb485d37d14715ffac90abc81c58f3370d598bf75be05605f8"
    swiftformat_asset="swiftformat_linux_aarch64.zip"; swiftformat_sha256="5ef87b1732964b0efc08eb66fc6c2a6ad01e3de26aa7bcccbf2cfbf983fb3ead"; swiftformat_name="swiftformat_linux_aarch64"
    ;;
  *)
    printf 'unsupported Swift style platform: %s\n' "$(uname -s):$(uname -m)" >&2
    exit 1
    ;;
esac

fetch_verified() {
  local url="$1" expected_sha256="$2" archive_path="$3" actual_sha256
  curl -fsSL "$url" -o "$archive_path"
  if [[ "$(uname -s)" == Darwin ]]; then
    actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
  else
    actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
  fi
  if [[ "$actual_sha256" != "$expected_sha256" ]]; then
    printf 'checksum mismatch for %s\n' "$(basename "$archive_path")" >&2
    return 1
  fi
  unzip -q -o "$archive_path" -d "$tmp_dir/bin"
}

mkdir "$tmp_dir/bin"
fetch_verified "https://github.com/realm/SwiftLint/releases/download/$swiftlint_version/$swiftlint_asset" \
  "$swiftlint_sha256" "$tmp_dir/$swiftlint_asset" &
swiftlint_job=$!
fetch_verified "https://github.com/nicklockwood/SwiftFormat/releases/download/$swiftformat_version/$swiftformat_asset" \
  "$swiftformat_sha256" "$tmp_dir/$swiftformat_asset" &
swiftformat_job=$!
wait "$swiftlint_job"
wait "$swiftformat_job"

swiftlint_bin="$tmp_dir/bin/swiftlint"
swiftformat_bin="$tmp_dir/bin/$swiftformat_name"
chmod +x "$swiftlint_bin" "$swiftformat_bin"
if [[ "$("$swiftlint_bin" version)" != "$swiftlint_version" ]]; then
  printf 'unexpected SwiftLint version\n' >&2
  exit 1
fi
if [[ "$("$swiftformat_bin" --version)" != "$swiftformat_version" ]]; then
  printf 'unexpected SwiftFormat version\n' >&2
  exit 1
fi

"$swiftformat_bin" --lint --config "$package_dir/.swiftformat" "$package_dir"
(cd "$package_dir" && "$swiftlint_bin" lint --config .swiftlint.yml --strict)

printf 'swift style checks passed (SwiftLint %s, SwiftFormat %s)\n' "$swiftlint_version" "$swiftformat_version"
