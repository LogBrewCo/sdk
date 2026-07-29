from __future__ import annotations

import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MINIMUM_FASTAPI_VERSION = "0.111.1"
LEGACY_HTTPX_VERSION = "0.23.3"


class FastAPICompatibilityTests(unittest.TestCase):
    def test_manifest_does_not_install_a_test_client_for_the_application(self) -> None:
        project = tomllib.loads(
            (ROOT / "python/logbrew_fastapi/pyproject.toml").read_text(
                encoding="utf-8"
            )
        )["project"]

        self.assertFalse(
            any(
                dependency.lower().startswith(("httpx", "httpx2"))
                for dependency in project["dependencies"]
            )
        )

    def test_manifest_declares_the_proven_fastapi_floor(self) -> None:
        project = tomllib.loads(
            (ROOT / "python/logbrew_fastapi/pyproject.toml").read_text(
                encoding="utf-8"
            )
        )["project"]

        self.assertIn(
            f"fastapi>={MINIMUM_FASTAPI_VERSION}",
            project["dependencies"],
        )

    def test_protected_checks_run_an_installed_smoke_at_the_floor(self) -> None:
        smoke = (ROOT / "scripts/real_user_fastapi_smoke.sh").read_text(
            encoding="utf-8"
        )
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        readiness = (ROOT / ".github/workflows/release-readiness.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("LOGBREW_FASTAPI_FRAMEWORK_VERSION", smoke)
        self.assertIn(
            '"fastapi==${LOGBREW_FASTAPI_FRAMEWORK_VERSION}"',
            smoke,
        )
        for workflow in (ci, readiness):
            self.assertIn(
                f"LOGBREW_FASTAPI_FRAMEWORK_VERSION: {MINIMUM_FASTAPI_VERSION}",
                workflow,
            )

    def test_protected_checks_run_with_the_legacy_httpx_pin(self) -> None:
        smoke = (ROOT / "scripts/real_user_fastapi_smoke.sh").read_text(
            encoding="utf-8"
        )
        ci = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        readiness = (ROOT / ".github/workflows/release-readiness.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("LOGBREW_FASTAPI_HTTPX_VERSION", smoke)
        self.assertIn(
            '"httpx==${LOGBREW_FASTAPI_HTTPX_VERSION}"',
            smoke,
        )
        for workflow in (ci, readiness):
            self.assertIn(
                f"LOGBREW_FASTAPI_HTTPX_VERSION: {LEGACY_HTTPX_VERSION}",
                workflow,
            )

    def test_public_docs_state_the_tested_compatibility_floor(self) -> None:
        readme = (ROOT / "python/logbrew_fastapi/README.md").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            f"FastAPI {MINIMUM_FASTAPI_VERSION} and later",
            readme,
        )


if __name__ == "__main__":
    unittest.main()
