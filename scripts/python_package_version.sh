#!/usr/bin/env bash

python_package_version() {
  local pyproject_path="$1"
  python3 - "$pyproject_path" <<'PY'
import re
import sys
from pathlib import Path

section = ""
for line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    stripped = line.strip()
    if stripped.startswith("[") and stripped.endswith("]"):
        section = stripped[1:-1].strip()
        continue
    if section != "project":
        continue
    match = re.fullmatch(r"""version\s*=\s*(['"])([^'"]+)\1(?:\s*#.*)?""", stripped)
    if match is not None:
        print(match.group(2))
        break
else:
    raise SystemExit(f"{sys.argv[1]} does not define a literal [project] version")
PY
}
