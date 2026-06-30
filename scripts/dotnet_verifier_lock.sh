dotnet_verifier_lock_dir="${TMPDIR:-/tmp}/logbrewco-sdk-dotnet-checks.lock"
dotnet_verifier_lock_pid_file="$dotnet_verifier_lock_dir/pid"
dotnet_verifier_lock_acquired=0

acquire_dotnet_verifier_lock() {
  if mkdir "$dotnet_verifier_lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$dotnet_verifier_lock_pid_file"
    dotnet_verifier_lock_acquired=1
    return 0
  fi

  local existing_pid=""
  if [[ -f "$dotnet_verifier_lock_pid_file" ]]; then
    existing_pid="$(tr -d '[:space:]' < "$dotnet_verifier_lock_pid_file")"
  fi

  if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
    return 1
  fi

  rm -rf "$dotnet_verifier_lock_dir"
  mkdir "$dotnet_verifier_lock_dir"
  printf '%s\n' "$$" > "$dotnet_verifier_lock_pid_file"
  dotnet_verifier_lock_acquired=1
}

release_dotnet_verifier_lock() {
  if [[ "${dotnet_verifier_lock_acquired:-0}" != "1" ]]; then
    return 0
  fi

  rm -f "$dotnet_verifier_lock_pid_file"
  rmdir "$dotnet_verifier_lock_dir" 2>/dev/null || true
  dotnet_verifier_lock_acquired=0
}
