#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/native_verifier.sh"
source "$repo_root/scripts/python_package_version.sh"

package_dir="$repo_root/python/logbrew_fastapi"
core_dir="$repo_root/python/logbrew_py"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
fastapi_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_FASTAPI_PACKAGE_VERSION="$fastapi_package_version"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/venv"
"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build twine >/dev/null

"$tmp_dir/venv/bin/python" -m build --wheel --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/fastapi-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
fastapi_wheel="$tmp_dir/fastapi-dist/logbrew_fastapi-${fastapi_package_version}-py3-none-any.whl"
fastapi_sdist="$tmp_dir/fastapi-dist/logbrew_fastapi-${fastapi_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$fastapi_wheel"
test -f "$fastapi_sdist"

"$tmp_dir/venv/bin/python" -m twine check "$fastapi_wheel" "$fastapi_sdist" >/dev/null

tar -tf "$fastapi_sdist" > "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/README.md$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/pyproject.toml$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/__init__.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/py.typed$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/examples/dependency_spans.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/examples/outbound_http.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/examples/readme_example.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_fastapi-${fastapi_package_version}/src/logbrew_fastapi/examples/real_user_smoke.py$" "$tmp_dir/sdist-contents.txt"
tar -xOf "$fastapi_sdist" "logbrew_fastapi-${fastapi_package_version}/README.md" > "$tmp_dir/sdist-README.md"
grep -q 'traceparent' "$tmp_dir/sdist-README.md"
grep -q 'span_id_factory' "$tmp_dir/sdist-README.md"
grep -q 'capture_request_metrics' "$tmp_dir/sdist-README.md"
grep -q 'init_logbrew' "$tmp_dir/sdist-README.md"
grep -q 'HttpTransport' "$tmp_dir/sdist-README.md"
grep -q 'custom FastAPI lifespan' "$tmp_dir/sdist-README.md"
grep -q 'logbrew-fastapi\[celery\]' "$tmp_dir/sdist-README.md"

"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
  "$core_wheel" "$fastapi_wheel" httpx2==2.3.0 >/dev/null
"$tmp_dir/venv/bin/python" -m pip check >/dev/null
if "$tmp_dir/venv/bin/python" -c 'import celery' 2>/dev/null; then
  printf '%s\n' "base logbrew-fastapi install unexpectedly included Celery" >&2
  exit 1
fi

run_native_verifier python-consumer fastapi "$repo_root" "$tmp_dir/venv/bin/python"

printf '%s\n' "fastapi package checks passed"
