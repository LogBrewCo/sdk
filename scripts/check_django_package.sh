#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/python_package_version.sh"

package_dir="$repo_root/python/logbrew_django"
core_dir="$repo_root/python/logbrew_py"
tmp_dir="$(mktemp -d)"
core_package_version="$(python_package_version "$core_dir/pyproject.toml")"
django_package_version="$(python_package_version "$package_dir/pyproject.toml")"
export LOGBREW_DJANGO_PACKAGE_VERSION="$django_package_version"

remove_tmp_dir() {
  rm -rf "$tmp_dir"
}

trap remove_tmp_dir EXIT

python3 -m venv "$tmp_dir/venv"
"$tmp_dir/venv/bin/python" -m pip install --upgrade --disable-pip-version-check pip >/dev/null
"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check build twine >/dev/null

"$tmp_dir/venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/core-dist" "$core_dir" >/dev/null
"$tmp_dir/venv/bin/python" -m build --wheel --sdist --outdir "$tmp_dir/django-dist" "$package_dir" >/dev/null

core_wheel="$tmp_dir/core-dist/logbrew_sdk-${core_package_version}-py3-none-any.whl"
django_wheel="$tmp_dir/django-dist/logbrew_django-${django_package_version}-py3-none-any.whl"
django_sdist="$tmp_dir/django-dist/logbrew_django-${django_package_version}.tar.gz"
test -f "$core_wheel"
test -f "$django_wheel"
test -f "$django_sdist"

"$tmp_dir/venv/bin/python" -m twine check "$django_wheel" "$django_sdist" >/dev/null

tar -tf "$django_sdist" > "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/README.md$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/pyproject.toml$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/src/logbrew_django/__init__.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/src/logbrew_django/py.typed$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/src/logbrew_django/examples/outbound_http.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/src/logbrew_django/examples/readme_example.py$" "$tmp_dir/sdist-contents.txt"
grep -q "^logbrew_django-${django_package_version}/src/logbrew_django/examples/real_user_smoke.py$" "$tmp_dir/sdist-contents.txt"
tar -xOf "$django_sdist" "logbrew_django-${django_package_version}/README.md" > "$tmp_dir/sdist-README.md"
grep -q 'traceparent' "$tmp_dir/sdist-README.md"
grep -q 'span_id_factory' "$tmp_dir/sdist-README.md"
grep -q 'capture_request_metrics' "$tmp_dir/sdist-README.md"

"$tmp_dir/venv/bin/python" -m pip install --no-cache-dir --disable-pip-version-check "$core_wheel" "$django_wheel" >/dev/null
"$tmp_dir/venv/bin/python" -m pip check >/dev/null

PYTHONPATH="" "$tmp_dir/venv/bin/python" -m unittest discover -s "$package_dir/tests" -p 'test_*.py'
PYTHONPATH="" "$tmp_dir/venv/bin/python" "$package_dir/examples/readme_example.py" > "$tmp_dir/readme.stdout.json" 2> "$tmp_dir/readme.stderr.json"
grep -q '"type": "span"' "$tmp_dir/readme.stdout.json"
grep -q '"status": 200' "$tmp_dir/readme.stderr.json"

PYTHONPATH="" "$tmp_dir/venv/bin/python" "$package_dir/examples/real_user_smoke.py" > "$tmp_dir/smoke.stdout.json" 2> "$tmp_dir/smoke.stderr.json"
grep -q '"type": "span"' "$tmp_dir/smoke.stdout.json"
grep -q '"type": "issue"' "$tmp_dir/smoke.stdout.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/smoke.stderr.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/smoke.stderr.json"
grep -q '"spanId": "b7ad6b7169203331"' "$tmp_dir/smoke.stderr.json"
grep -q '"path": "/health/"' "$tmp_dir/smoke.stderr.json"
grep -q '"events": 3' "$tmp_dir/smoke.stderr.json"
python3 "$repo_root/scripts/validate_fixtures.py" "$tmp_dir/smoke.stdout.json" >/dev/null

PYTHONPATH="" "$tmp_dir/venv/bin/python" -m logbrew_django.examples --list > "$tmp_dir/examples-list.txt"
grep -qx 'readme-example -> python -m logbrew_django.examples readme-example' <(sed -n '1p' "$tmp_dir/examples-list.txt")
grep -qx 'outbound-http -> python -m logbrew_django.examples outbound-http' <(sed -n '2p' "$tmp_dir/examples-list.txt")
grep -qx 'real-user-smoke -> python -m logbrew_django.examples real-user-smoke' <(sed -n '3p' "$tmp_dir/examples-list.txt")
grep -qx 'default (real-user-smoke) -> python -m logbrew_django.examples' <(sed -n '4p' "$tmp_dir/examples-list.txt")
PYTHONPATH="" "$tmp_dir/venv/bin/python" -m logbrew_django.examples readme-example > "$tmp_dir/packaged-readme.stdout.json" 2> "$tmp_dir/packaged-readme.stderr.json"
grep -q '"type": "span"' "$tmp_dir/packaged-readme.stdout.json"
PYTHONPATH="" "$tmp_dir/venv/bin/python" -m logbrew_django.examples outbound-http > "$tmp_dir/packaged-outbound.stdout.json" 2> "$tmp_dir/packaged-outbound.stderr.json"
grep -q '"type": "span"' "$tmp_dir/packaged-outbound.stdout.json"
grep -q '"requestSpanId": "b7ad6b7169203331"' "$tmp_dir/packaged-outbound.stderr.json"
grep -q '"outboundParentSpanId": "b7ad6b7169203331"' "$tmp_dir/packaged-outbound.stderr.json"
grep -q '"outboundSpanId": "c8ad6b7169203332"' "$tmp_dir/packaged-outbound.stderr.json"
grep -q '"traceparentMatchesSpan": true' "$tmp_dir/packaged-outbound.stderr.json"
PYTHONPATH="" "$tmp_dir/venv/bin/python" -m logbrew_django.examples real-user-smoke > "$tmp_dir/packaged-smoke.stdout.json" 2> "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"' "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"parentSpanId": "00f067aa0ba902b7"' "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"spanId": "b7ad6b7169203331"' "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"path": "/health/"' "$tmp_dir/packaged-smoke.stderr.json"
grep -q '"events": 3' "$tmp_dir/packaged-smoke.stderr.json"

printf '%s\n' "django package checks passed"
