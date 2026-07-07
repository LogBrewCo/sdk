#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/venv"
"$tmp_dir/venv/bin/python" -m pip install \
  --upgrade \
  --disable-pip-version-check \
  pip \
  >/dev/null
"$tmp_dir/venv/bin/python" -m pip install \
  --no-cache-dir \
  --disable-pip-version-check \
  ruff==0.15.15 \
  mypy==2.1.0 \
  django==6.0.6 \
  django-stubs==6.0.5 \
  fastapi==0.136.3 \
  Flask==3.1.2 \
  httpx2==2.3.0 \
  >/dev/null

cd "$repo_root"

RUFF_CACHE_DIR="$tmp_dir/ruff-cache" "$tmp_dir/venv/bin/ruff" check \
  --isolated \
  --target-version py311 \
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

MYPYPATH="$repo_root/python/logbrew_py/src:$repo_root/python/logbrew_fastapi/src:$repo_root/python/logbrew_flask/src:$repo_root/python/logbrew_django/src" "$tmp_dir/venv/bin/mypy" \
  --strict \
  --python-version 3.11 \
  --explicit-package-bases \
  --cache-dir "$tmp_dir/mypy-cache" \
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
