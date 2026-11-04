#!/usr/bin/env bash
# Install the four Python packages from copies of their source directories, with the frameworks the probes use, into one virtualenv in $1.
set -euo pipefail

work="$1"
sdk="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
packages=(logbrew_py logbrew_flask logbrew_fastapi logbrew_django)
frameworks=("Flask==3.1.3" "fastapi==0.162.0" "httpx==0.28.1" "Django==5.2.16" "certifi==2026.7.22" "truststore==0.10.4")

stamp="$(
  cd "$sdk/python"
  {
    find "${packages[@]}" -type f \( -name '*.py' -o -name '*.toml' -o -name '*.typed' -o -name '*.in' \) \
      -not -path '*/tests/*' -not -path '*.egg-info/*' -not -path '*/build/*' -print0 | sort -z | xargs -0 shasum -a 256
    printf '%s\n' "${frameworks[@]}"
  } | shasum -a 256 | cut -d ' ' -f 1
)"
if [[ -f "$work/.installed" && "$(cat "$work/.installed")" == "$stamp" ]]; then
  exit 0
fi

rm -rf "$work/src"
mkdir -p "$work/src"
for package in "${packages[@]}"; do
  cp -R "$sdk/python/$package" "$work/src/$package"
  rm -rf "$work/src/$package/tests" "$work/src/$package"/src/*.egg-info "$work/src/$package/build"
done
[[ -x "$work/venv/bin/python" ]] || python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip install --quiet --disable-pip-version-check --no-cache-dir \
  "${frameworks[@]}" "${packages[@]/#/$work/src/}" >/dev/null
"$work/venv/bin/python" -m pip check >/dev/null
printf '%s' "$stamp" >"$work/.installed"
