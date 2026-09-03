#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tool_env="${LOGBREW_PYTHON_STATIC_ENV:-${XDG_DATA_HOME:-$HOME/.local/share}/logbrew-tools/python-static/ruff-0.15.15-mypy-2.1.0}"
cache_dir="${LOGBREW_PYTHON_STATIC_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/logbrew/python-static/ruff-0.15.15-mypy-2.1.0}"
mkdir -p "$cache_dir"

tool_python="$tool_env/bin/python"
tool_ruff="$tool_env/bin/ruff"
if [[ ! -x "$tool_python" || ! -x "$tool_ruff" ]]; then
  printf '%s\n' "provision the Python static-analysis environment from scripts/python_static_tools.txt" >&2
  exit 1
fi

"$tool_python" - "$repo_root/scripts/python_static_tools.txt" <<'PY'
from importlib.metadata import version
from pathlib import Path
import sys

for requirement in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    name, expected = requirement.split("==", 1)
    actual = version(name)
    if actual != expected:
        raise SystemExit(f"{name} {expected} is required, found {actual}")
PY

cd "$repo_root"

RUFF_CACHE_DIR="$cache_dir/ruff" "$tool_ruff" check \
  --isolated \
  --target-version py310 \
  --line-length 120 \
  --select E,F,I,UP,B,SIM,PERF,RUF,PL \
  --ignore PLR2004,PLR0913 \
  python/logbrew_py/src \
  python/logbrew_py/examples \
  python/logbrew_py/tests \
  python/logbrew_fastapi/src \
  python/logbrew_fastapi/examples \
  python/logbrew_fastapi/tests \
  python/logbrew_flask/src \
  python/logbrew_flask/examples \
  python/logbrew_flask/tests \
  python/logbrew_django/src \
  python/logbrew_django/examples \
  python/logbrew_django/tests \
  scripts/check_python_sources.py

MYPYPATH="$repo_root/python/logbrew_py/src:$repo_root/python/logbrew_py/tests:$repo_root/python/logbrew_fastapi/src:$repo_root/python/logbrew_flask/src:$repo_root/python/logbrew_django/src" "$tool_python" -m mypy \
  --strict \
  --python-version 3.10 \
  --explicit-package-bases \
  --cache-dir "$cache_dir/mypy" \
  python/logbrew_py/src \
  python/logbrew_py/examples \
  python/logbrew_py/tests \
  python/logbrew_fastapi/src \
  python/logbrew_fastapi/examples \
  python/logbrew_fastapi/tests \
  python/logbrew_flask/src \
  python/logbrew_flask/examples \
  python/logbrew_flask/tests \
  python/logbrew_django/src \
  python/logbrew_django/examples \
  python/logbrew_django/tests \
  scripts/check_python_sources.py

printf '%s\n' "python static analysis ok"
