#!/usr/bin/env bash

run_native_verifier() {
  if [[ -n "${LOGBREW_TOOLCHAIN_PROBE_BIN:-}" ]]; then
    if [[ "$LOGBREW_TOOLCHAIN_PROBE_BIN" != /* || ! -f "$LOGBREW_TOOLCHAIN_PROBE_BIN" ||
      -L "$LOGBREW_TOOLCHAIN_PROBE_BIN" || ! -x "$LOGBREW_TOOLCHAIN_PROBE_BIN" ]]; then
      printf '%s\n' "native SDK verifier path is invalid" >&2
      return 1
    fi
    "$LOGBREW_TOOLCHAIN_PROBE_BIN" "$@"
    return
  fi
  (
    native_dir="$(mktemp -d "${TMPDIR:-/tmp}/logbrew-native-verifier.XXXXXX")" || exit
    trap 'rm -rf "$native_dir"' EXIT
    build_native_verifier "$native_dir/toolchain-probe" || exit
    "$native_dir/toolchain-probe" "$@"
  )
}

build_native_verifier() (
  native_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/toolchain-probe"
  if [[ ! -d "$native_root" || -L "$native_root" || -L "${native_root%/*}" ]]; then
    printf '%s\n' "native SDK verifier source is unavailable" >&2
    return 1
  fi
  for native_file in .go-version go.mod go.sum; do
    if [[ "$native_file" == go.sum && ! -e "$native_root/$native_file" && ! -L "$native_root/$native_file" ]]; then
      continue
    fi
    if [[ ! -f "$native_root/$native_file" || -L "$native_root/$native_file" ]]; then
      printf '%s\n' "native SDK verifier source is incomplete" >&2
      return 1
    fi
  done
  IFS= read -r toolchain_version < "$native_root/.go-version" || return
  if [[ ! "$toolchain_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s\n' "native SDK verifier compiler pin is invalid" >&2
    return 1
  fi
  go_env=(GOENV=off GOWORK=off GOFLAGS=-mod=readonly)
  fetch_env=("${go_env[@]}" GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org)
  build_env=("${go_env[@]}" GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off)
  native_go=go
  # Like the CI action, fetch the pinned toolchain and the modules only through checksum
  # verification, then build offline.
  if [[ "$(env "${build_env[@]}" go version)" != "go version go$toolchain_version "* ]]; then
    if ! native_goroot="$(env "${fetch_env[@]}" GOTOOLCHAIN="go$toolchain_version" go env GOROOT)"; then
      printf '%s\n' "native SDK verifier requires Go $toolchain_version" >&2
      return 1
    fi
    native_go="$native_goroot/bin/go"
  fi
  cd "$native_root" || return
  env "${fetch_env[@]}" GOTOOLCHAIN=local "$native_go" mod download || return
  env "${build_env[@]}" "$native_go" build -o "$1" .
)
