from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CORE_PACKAGE = ROOT / "js" / "logbrew-js"


class ReactNativeMobileCoreContractTests(unittest.TestCase):
    def test_package_owns_a_typed_react_native_condition(self) -> None:
        manifest = json.loads(
            (CORE_PACKAGE / "package.json").read_text(encoding="utf-8")
        )

        self.assertEqual(
            {
                "types": "./react-native.d.ts",
                "default": "./react-native.js",
            },
            manifest["exports"]["."]["react-native"],
        )
        self.assertEqual("./react-native.js", manifest["react-native"])
        self.assertTrue(
            {
                "core.cjs",
                "react-native.d.ts",
                "react-native.js",
                "winston.cjs",
            }.issubset(set(manifest["files"]))
        )

    def test_mobile_core_and_node_adapter_have_one_way_ownership(self) -> None:
        entry = (CORE_PACKAGE / "index.cjs").read_text(encoding="utf-8")
        core = (CORE_PACKAGE / "core.cjs").read_text(encoding="utf-8")
        mobile = (CORE_PACKAGE / "react-native.js").read_text(encoding="utf-8")
        winston = (CORE_PACKAGE / "winston.cjs").read_text(encoding="utf-8")

        self.assertIn('require("./core.cjs")', entry)
        self.assertIn('require("./winston.cjs")', entry)
        self.assertIn('from "./core.cjs"', mobile)
        self.assertNotIn("node:", core)
        self.assertNotIn("Winston", core)
        self.assertNotIn("winston", core)
        self.assertNotIn("node:", mobile)
        self.assertIn('require("node:stream")', winston)
        self.assertLess(len(winston.splitlines()), 400)
        self.assertLess(len(mobile.splitlines()), 100)

    def test_mobile_entry_exports_the_complete_canonical_core(self) -> None:
        completed = subprocess.run(
            ["node", "--input-type=module", "-"],
            cwd=CORE_PACKAGE,
            check=True,
            capture_output=True,
            input="""
import { createRequire } from "node:module";
import mobile, * as mobileNamespace from "./react-native.js";

const require = createRequire(import.meta.url);
const core = require("./core.cjs");
const mobileNames = Object.keys(mobileNamespace)
  .filter((name) => name !== "default")
  .sort();
const coreNames = Object.keys(core).sort();
if (JSON.stringify(mobileNames) !== JSON.stringify(coreNames)) {
  throw new Error("React Native entry drifted from the canonical core");
}
if (mobile !== core) {
  throw new Error("React Native default is not the canonical core");
}
""",
            text=True,
        )

        self.assertEqual("", completed.stderr)

    def test_pack_dry_run_contains_every_runtime_and_type_entry(self) -> None:
        completed = subprocess.run(
            ["npm", "pack", "--dry-run", "--json"],
            cwd=CORE_PACKAGE,
            check=True,
            capture_output=True,
            text=True,
        )
        packed = {entry["path"] for entry in json.loads(completed.stdout)[0]["files"]}

        self.assertTrue(
            {
                "core.cjs",
                "index.cjs",
                "index.d.cts",
                "index.d.ts",
                "index.js",
                "react-native.d.ts",
                "react-native.js",
                "winston.cjs",
            }.issubset(packed)
        )

    def test_exact_bundle_regression_is_a_javascript_ci_gate(self) -> None:
        script = (
            ROOT / "scripts" / "real_user_react_native_bundle_smoke.sh"
        ).read_text(encoding="utf-8")
        workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn('react_native_version="0.86.0"', script)
        self.assertIn("createLogBrewReactNativeClient", script)
        self.assertIn("--conditions=react-native", script)
        self.assertIn("nodeBuiltinReferences", script)
        self.assertIn("Run React Native release bundle smoke test", workflow)
        self.assertIn(
            "bash scripts/real_user_react_native_bundle_smoke.sh",
            workflow,
        )


if __name__ == "__main__":
    unittest.main()
