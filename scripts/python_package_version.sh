#!/usr/bin/env bash

python_package_version() {
  local pyproject_path="$1"
  python3 - "$pyproject_path" <<'PY'
import sys
import tomllib

with open(sys.argv[1], "rb") as handle:
    print(tomllib.load(handle)["project"]["version"])
PY
}
