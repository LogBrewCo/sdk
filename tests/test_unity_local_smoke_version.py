from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_MANIFEST = ROOT / "unity" / "logbrew-unity" / "package.json"
SCRIPT = ROOT / "scripts" / "real_user_unity_smoke.sh"


class UnityLocalSmokeVersionTests(unittest.TestCase):
    def test_local_unity_smoke_uses_current_package_version(self) -> None:
        package_version = json.loads(PACKAGE_MANIFEST.read_text(encoding="utf-8"))["version"]
        script = SCRIPT.read_text(encoding="utf-8")

        self.assertIn(f"co.logbrew.unity-{package_version}.tgz", script)
        self.assertIn(f'package_manifest.get("version") != "{package_version}"', script)
        self.assertNotIn('package_manifest.get("version") != "0.1.0"', script)


if __name__ == "__main__":
    unittest.main()
