#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
shellcheck_version="v0.11.0"
trap 'find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
  Darwin:arm64 | Darwin:aarch64) asset="shellcheck-$shellcheck_version.darwin.aarch64.tar.gz"; expected_sha256="339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f" ;;
  Darwin:x86_64) asset="shellcheck-$shellcheck_version.darwin.x86_64.tar.gz"; expected_sha256="c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51" ;;
  Linux:arm64 | Linux:aarch64) asset="shellcheck-$shellcheck_version.linux.aarch64.tar.gz"; expected_sha256="68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc" ;;
  Linux:x86_64) asset="shellcheck-$shellcheck_version.linux.x86_64.tar.gz"; expected_sha256="b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6" ;;
  *)
    printf 'unsupported ShellCheck platform: %s\n' "$(uname -s):$(uname -m)" >&2
    exit 1
    ;;
esac

archive_path="$tmp_dir/$asset"
curl -fsSL "https://github.com/koalaman/shellcheck/releases/download/$shellcheck_version/$asset" -o "$archive_path"
if [[ "$(uname -s)" == Darwin ]]; then
  actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
else
  actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  printf 'ShellCheck archive checksum mismatch for %s\n' "$asset" >&2
  exit 1
fi
tar -xzf "$archive_path" -C "$tmp_dir"
shellcheck_bin="$tmp_dir/shellcheck-$shellcheck_version/shellcheck"
installed_version="$("$shellcheck_bin" --version | awk '/^version:/ { print $2 }')"
if [[ "v$installed_version" != "$shellcheck_version" ]]; then
  printf 'unexpected ShellCheck version: %s\n' "$installed_version" >&2
  exit 1
fi

cd "$repo_root"
"$shellcheck_bin" \
  --shell=bash \
  --external-sources \
  --source-path=SCRIPTDIR \
  --severity=style \
  --exclude=SC1091,SC2016 \
  scripts/*.sh
bash -n scripts/*.sh

printf 'shell static analysis ok (ShellCheck %s)\n' "$installed_version"
