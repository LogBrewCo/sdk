#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/native_verifier.sh"
source "$repo_root/scripts/python_package_version.sh"

package_dir="$repo_root/python/logbrew_flask"
core_dir="$repo_root/python/logbrew_py"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
flask_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_FLASK_PACKAGE_VERSION="$flask_package_version"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/venv"
"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build twine typing-extensions==4.16.0 >/dev/null

"$tmp_dir/venv/bin/python" -m build --wheel --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/flask-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
flask_wheel="$tmp_dir/flask-dist/logbrew_flask-${flask_package_version}-py3-none-any.whl"
flask_sdist="$tmp_dir/flask-dist/logbrew_flask-${flask_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$flask_wheel"
test -f "$flask_sdist"

"$tmp_dir/venv/bin/python" -m twine check "$flask_wheel" "$flask_sdist" >/dev/null

tar -tf "$flask_sdist" > "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/README.md$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/pyproject.toml$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/__init__.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/py.typed$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/examples/readme_example.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/examples/real_user_smoke.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/examples/outbound_http.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_flask-${flask_package_version}/src/logbrew_flask/examples/dependency_spans.py$" "$tmp_dir/sdist-contents.txt"
tar -xOf "$flask_sdist" "logbrew_flask-${flask_package_version}/README.md" > "$tmp_dir/sdist-README.md"
grep -q 'traceparent' "$tmp_dir/sdist-README.md"
grep -q 'span_id_factory' "$tmp_dir/sdist-README.md"
grep -q 'capture_request_metrics' "$tmp_dir/sdist-README.md"

"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check "$core_wheel" "$flask_wheel" >/dev/null
"$tmp_dir/venv/bin/python" -m pip check >/dev/null

run_native_verifier python-consumer flask "$repo_root" "$tmp_dir/venv/bin/python"

printf '%s\n' "flask package checks passed"
