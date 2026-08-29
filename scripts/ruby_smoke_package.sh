#!/usr/bin/env bash

declare tmp_dir package_dir package_version repo_root gem_digest ruby_bin gem_path

ruby_smoke_create_tmp_dir() {
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir"' EXIT
}

ruby_smoke_cleanup_server() {
  local server_pid="${1:-}"
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}

ruby_smoke_prepare_package() {
  local ruby_preference="${1:-system}"
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  package_dir="$repo_root/ruby/logbrew-ruby"
  ruby_bin=""
  if [[ "$ruby_preference" == homebrew ]]; then
    ruby_bin="${LOGBREW_RUBY_BIN:-}"
    if [[ -z "$ruby_bin" && -x /opt/homebrew/opt/ruby/bin/ruby ]]; then
      ruby_bin=/opt/homebrew/opt/ruby/bin/ruby
    fi
  fi
  ruby_bin="${ruby_bin:-$(command -v ruby)}"
  package_version="$(
    cd "$package_dir" || return
    "$ruby_bin" -e 'spec = Gem::Specification.load("logbrew-sdk.gemspec") or abort "invalid gemspec"; print spec.version'
  )"
  gem_path="$tmp_dir/logbrew-sdk-${package_version}.gem"
  (cd "$package_dir" && "$ruby_bin" -S gem build logbrew-sdk.gemspec --strict --output "$gem_path" >/dev/null)
  gem_digest="$(shasum -a 256 "$gem_path" | awk '{print $1}')"
  [[ "$gem_digest" =~ ^[0-9a-f]{64}$ ]]
}

ruby_smoke_install_local() {
  local install_home="$1"
  mkdir -p "$install_home"
  GEM_HOME="$install_home" GEM_PATH="$install_home" "$ruby_bin" -S gem install \
    --local --install-dir "$install_home" --no-document "$gem_path" >/dev/null
}
