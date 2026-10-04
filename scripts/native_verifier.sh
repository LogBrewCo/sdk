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
    native_root="$repo_root/tools/toolchain-probe"
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
    export GOENV=off GOWORK=off GOTOOLCHAIN=local GOFLAGS=-mod=readonly GOPROXY=off GOSUMDB=off
    if [[ "$(go version)" != "go version go$toolchain_version "* ]]; then
      printf '%s\n' "native SDK verifier requires Go $toolchain_version" >&2
      return 1
    fi
    cd "$native_root" || return
    go run . "$@"
  )
}
