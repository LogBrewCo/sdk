from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_repo_wide_release_versions.py"
SPEC = importlib.util.spec_from_file_location("check_repo_wide_release_versions", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
check_repo_wide_release_versions = importlib.util.module_from_spec(SPEC)
sys.modules["check_repo_wide_release_versions"] = check_repo_wide_release_versions
SPEC.loader.exec_module(check_repo_wide_release_versions)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class RepoWideReleaseVersionTests(unittest.TestCase):
    def test_normalizes_repo_wide_release_tags(self) -> None:
        self.assertEqual(check_repo_wide_release_versions.release_version("v0.1.1"), "0.1.1")
        self.assertEqual(
            check_repo_wide_release_versions.release_version("refs/tags/v0.1.1"),
            "0.1.1",
        )

    def test_rejects_non_repo_wide_release_tags(self) -> None:
        with self.assertRaisesRegex(ValueError, "expected repo-wide release tag"):
            check_repo_wide_release_versions.release_version("go/logbrew/v0.1.1")

    def test_reports_mixed_package_versions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = check_repo_wide_release_versions.REPO_WIDE_RELEASE_MANIFESTS[0]
            write(root / manifest.path, json.dumps({"version": "0.1.0"}))

            with mock.patch.object(
                check_repo_wide_release_versions,
                "REPO_WIDE_RELEASE_MANIFESTS",
                (manifest,),
            ):
                failures = check_repo_wide_release_versions.mismatches(root, "0.1.1")

            self.assertEqual(len(failures), 1)
            self.assertEqual(failures[0].manifest.label, "@logbrew/sdk")
            self.assertEqual(failures[0].version, "0.1.0")


if __name__ == "__main__":
    unittest.main()
