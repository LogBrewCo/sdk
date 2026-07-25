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

    def test_packed_smoke_proves_nonfatal_contract_without_promise_ownership(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_react_native_smoke.sh").read_text(
            encoding="utf-8"
        )

        for expected in (
            "@logbrew/react-native/global-errors",
            "installLogBrewReactNativeGlobalErrorHandler",
            "preRootError",
            "postMountError",
            "globalErrorInstallation.remove()",
            '"globalHandlerRemoved":true',
            '"globalReports":2',
        ):
            self.assertIn(expected, smoke)

    def test_documentation_states_stable_id_at_least_once_and_excluded_boundaries(self) -> None:
        readme = (PACKAGE_ROOT / "README.md").read_text(encoding="utf-8")

        self.assertIn("stable-ID at-least-once replay", readme)
        self.assertIn("acknowledgement happens only after local queue admission", readme)
        self.assertIn("does not claim mathematically exactly-once delivery", readme)
        self.assertIn("Unhandled Promise rejections are not installed or patched", readme)
        for excluded in (
            "native crash capture",
            "ANR or hang detection",
            "general offline queueing",
            "symbolication",
        ):
            self.assertIn(excluded, readme)


if __name__ == "__main__":
    unittest.main()
