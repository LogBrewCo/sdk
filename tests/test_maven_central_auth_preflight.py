from __future__ import annotations

import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_maven_central_auth_preflight.sh"


class MavenCentralAuthPreflightTests(unittest.TestCase):
    def run_preflight(
        self,
        *,
        http_status: str,
        username: str = "user-token",
        password: str = "secret-token",
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            fake_curl = Path(tmp) / "fake-curl"
            fake_curl.write_text(
                textwrap.dedent(
                    f"""\
                    #!/usr/bin/env bash
                    printf '%s\\n' "{http_status}"
                    """
                ),
                encoding="utf-8",
            )
            fake_curl.chmod(0o755)
            env = os.environ.copy()
            env.update(
                {
                    "CENTRAL_PORTAL_USERNAME": username,
                    "CENTRAL_PORTAL_PASSWORD": password,
                    "LOGBREW_CENTRAL_CURL": str(fake_curl),
                }
            )
            return subprocess.run(
                ["bash", str(SCRIPT)],
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )

    def test_accepts_non_auth_status_without_printing_secret_values(self) -> None:
        result = self.run_preflight(http_status="404")

        self.assertEqual(result.returncode, 0, result.stderr)
        output = result.stdout + result.stderr
        self.assertIn("Maven Central auth preflight passed", output)
        self.assertNotIn("user-token", output)
        self.assertNotIn("secret-token", output)

    def test_rejects_auth_status_with_generated_token_hint(self) -> None:
        result = self.run_preflight(http_status="401")

        self.assertEqual(result.returncode, 2)
        output = result.stdout + result.stderr
        self.assertIn("Maven Central authentication preflight failed", output)
        self.assertIn("generated Central Portal publishing values", output)
        self.assertNotIn("user-token", output)
        self.assertNotIn("secret-token", output)

    def test_requires_secret_env_names_without_printing_values(self) -> None:
        env = os.environ.copy()
        env.pop("CENTRAL_PORTAL_USERNAME", None)
        env.pop("CENTRAL_PORTAL_PASSWORD", None)

        result = subprocess.run(
            ["bash", str(SCRIPT)],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

        self.assertEqual(result.returncode, 2)
        self.assertIn("CENTRAL_PORTAL_USERNAME", result.stderr)
        self.assertIn("CENTRAL_PORTAL_PASSWORD", result.stderr)


if __name__ == "__main__":
    unittest.main()
