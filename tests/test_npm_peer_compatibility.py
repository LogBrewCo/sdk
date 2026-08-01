from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_npm_peer_compatibility.py"
SPEC = importlib.util.spec_from_file_location("check_npm_peer_compatibility", MODULE_PATH)
assert SPEC is not None
check_npm_peer_compatibility = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_npm_peer_compatibility)


class NpmPeerCompatibilityTests(unittest.TestCase):
    def test_caret_range_respects_zero_major_boundaries(self) -> None:
        allows = check_npm_peer_compatibility.caret_range_allows
        self.assertTrue(allows("^0.1.2", "0.1.3"))
        self.assertTrue(allows("^0.1.2", "0.1.99"))
        self.assertFalse(allows("^0.1.2", "0.2.0"))
        self.assertTrue(allows("^0.0.2", "0.0.2"))
        self.assertFalse(allows("^0.0.2", "0.0.3"))
        self.assertTrue(allows("^1.2.3", "1.9.0"))
        self.assertFalse(allows("^1.2.3", "2.0.0"))

    def test_manifest_validation_requires_compatible_declared_peers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            manifest_path = Path(tmp) / "package.json"
            manifest_path.write_text(
                json.dumps({
                    "peerDependencies": {
                        "@logbrew/node": "^0.1.2",
                        "@logbrew/sdk": "^0.1.3",
                    }
                }),
                encoding="utf-8",
            )
            self.assertEqual(
                check_npm_peer_compatibility.validate(
                    manifest_path,
                    {"@logbrew/node": "0.1.3", "@logbrew/sdk": "0.1.6"},
                ),
                [],
            )
            failures = check_npm_peer_compatibility.validate(
                manifest_path,
                {"@logbrew/node": "0.2.0", "@logbrew/missing": "0.1.0"},
            )

        self.assertEqual(len(failures), 2)
        self.assertTrue(any("@logbrew/node" in failure for failure in failures))
        self.assertTrue(any("@logbrew/missing" in failure for failure in failures))


if __name__ == "__main__":
    unittest.main()
