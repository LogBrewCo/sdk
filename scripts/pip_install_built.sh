#!/usr/bin/env bash
#
# Installs a wheel or sdist that this run built, in pip's hash-checking mode,
# pinned to the artifact's SHA-256. pip runs offline (--no-index), so every
# dependency must already be installed, and a missing one fails the install.
#
# Usage: bash scripts/pip_install_built.sh PYTHON ARTIFACT REQUIREMENT [PIP_OPTION...]
#   REQUIREMENT is the package name with any extras, such as 'logbrew-sdk[rq]'.

set -euo pipefail

python="$1"
artifact="$2"
requirement="$3"
shift 3

requirements_file="$(mktemp)"
trap 'rm -f "$requirements_file"' EXIT

"$python" - "$artifact" "$requirement" >"$requirements_file" <<'PY'
import hashlib
import pathlib
import sys

artifact = pathlib.Path(sys.argv[1]).resolve(strict=True)
digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
print(f"{sys.argv[2]} @ {artifact.as_uri()} --hash=sha256:{digest}")
PY

"$python" -m pip install --no-index --require-hashes --requirement "$requirements_file" "$@"
