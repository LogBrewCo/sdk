from __future__ import annotations

import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = ROOT / "js" / "logbrew-react-native"


class ReactNativeGlobalErrorsTests(unittest.TestCase):
    def test_package_exposes_only_the_honest_global_report_subpath(self) -> None:
        manifest = json.loads((PACKAGE_ROOT / "package.json").read_text(encoding="utf-8"))
        export = manifest["exports"]["./global-errors"]

        self.assertEqual(export["import"]["types"], "./global-errors.d.ts")
        self.assertEqual(export["import"]["default"], "./global-errors.js")
        self.assertEqual(export["require"]["types"], "./global-errors.d.cts")
        self.assertEqual(export["require"]["default"], "./global-errors.cjs")
        for filename in (
            "global-errors.cjs",
            "global-errors.d.cts",
            "global-errors.d.ts",
            "global-errors.js",
        ):
            self.assertIn(filename, manifest["files"])
        self.assertNotIn("./unhandled-errors", manifest["exports"])

    def test_packed_smoke_proves_pre_root_post_mount_privacy_and_rollback(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_react_native_smoke.sh").read_text(
            encoding="utf-8"
        )

        for expected in (
            "@logbrew/react-native/global-errors",
            "installLogBrewReactNativeGlobalErrorHandler",
            "preRootError",
            "postMountError",
            "fatal_capture_requires_sync_store",
            "globalErrorInstallation.remove()",
            '"globalHandlerRemoved":true',
            '"globalReports":2',
        ):
            self.assertIn(expected, smoke)

    def test_documentation_keeps_fatal_and_promise_limits_explicit(self) -> None:
        readme = (PACKAGE_ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("Fatal JavaScript errors are chained without capture", readme)
        self.assertIn("synchronous native durable handoff", readme)
        self.assertIn("Unhandled Promise rejections are not installed or patched", readme)
        self.assertNotIn("exactly-once fatal replay is supported", readme)


if __name__ == "__main__":
    unittest.main()
