#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
version="2025.1.1"
trap 'find "$tmp_dir" -depth -delete' EXIT

case "$(uname -s):$(uname -m)" in
	Darwin:arm64 | Darwin:aarch64) asset="staticcheck_darwin_arm64.tar.gz"; expected_sha256="ce1911c11ec2c079936a80163dba10156c7c79fd1423d432b2a24825a22f5e8d" ;;
	Darwin:x86_64) asset="staticcheck_darwin_amd64.tar.gz"; expected_sha256="d66e2d65efc02c314b578b28a8db3008f82f8fc1c8eb6edcbe04b3c3444a1f8a" ;;
	Linux:arm64 | Linux:aarch64) asset="staticcheck_linux_arm64.tar.gz"; expected_sha256="b135fd89dbc875f20d83e66948fff256af738b33b48a64024c0752f29ea1eb13" ;;
	Linux:x86_64) asset="staticcheck_linux_amd64.tar.gz"; expected_sha256="ae320e410225295ecb2a2cd406113e3c2fe40521aaed984dd11dc41a0a50b253" ;;
	*)
		printf 'unsupported Staticcheck platform: %s\n' "$(uname -s):$(uname -m)" >&2
		exit 1
		;;
esac

archive_path="$tmp_dir/$asset"
curl -fsSL "https://github.com/dominikh/go-tools/releases/download/$version/$asset" -o "$archive_path"
if [[ "$(uname -s)" == Darwin ]]; then
	actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
else
	actual_sha256="$(sha256sum "$archive_path" | awk '{print $1}')"
fi
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
	printf 'Staticcheck archive checksum mismatch for %s\n' "$asset" >&2
	exit 1
fi
tar -xzf "$archive_path" -C "$tmp_dir"
staticcheck_bin="$tmp_dir/staticcheck/staticcheck"
if [[ "$("$staticcheck_bin" -version)" != "staticcheck $version (0.6.1)" ]]; then
	printf '%s\n' "unexpected Staticcheck version" >&2
	exit 1
fi

while IFS= read -r dir; do
	(cd "$dir" && "$staticcheck_bin" ./...)
done < <(find "$repo_root/go/logbrew" -name go.mod -exec dirname {} \; | sort -u)

printf 'go static analysis ok (Staticcheck %s)\n' "$version"
