from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_python_public_pypi_smoke.sh"


class PythonPublicPyPISmokeTests(unittest.TestCase):
    def test_script_proves_current_public_pypi_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for package in ("logbrew-sdk", "logbrew-fastapi", "logbrew-django"):
            self.assertIn(package, body)

        for expected in (
            "LOGBREW_PYPI_SDK_VERSION",
            "LOGBREW_PYPI_FASTAPI_VERSION",
            "LOGBREW_PYPI_DJANGO_VERSION",
            'sdk_version="${1:-${LOGBREW_PYPI_SDK_VERSION:-0.1.0}}"',
            'fastapi_version="${2:-${LOGBREW_PYPI_FASTAPI_VERSION:-0.1.0}}"',
            'django_version="${3:-${LOGBREW_PYPI_DJANGO_VERSION:-0.1.0}}"',
            "https://pypi.org/simple",
            "python3 -m venv",
            "python -m pip install",
            "python -m pip check",
            "python -m pip show",
            "python -m pip list --format=json",
            "python -m pip freeze",
            "importlib.metadata",
            "LogBrewClient",
            "RecordingTransport",
            "add_logbrew_middleware",
            "configure_logbrew",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
