from __future__ import annotations

import argparse
import importlib.util
import sys
import unittest
import urllib.error
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_registry_publication.py"
SPEC = importlib.util.spec_from_file_location("check_registry_publication", MODULE_PATH)
assert SPEC is not None
check_registry_publication = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules["check_registry_publication"] = check_registry_publication
SPEC.loader.exec_module(check_registry_publication)


class RegistryPublicationTests(unittest.TestCase):
    def test_extracts_versions_from_supported_registry_shapes(self) -> None:
        self.assertIn("0.1.0", check_registry_publication.npm_versions({"dist-tags": {"latest": "0.1.0"}}))
        self.assertIn("0.1.0", check_registry_publication.pypi_versions({"info": {"version": "0.1.0"}}))
        self.assertIn("0.1.0", check_registry_publication.rubygems_versions({"version": "0.1.0"}))
        self.assertIn("0.1.0", check_registry_publication.nuget_versions({"versions": ["0.1.0"]}))
        self.assertIn(
            "0.1.0",
            check_registry_publication.packagist_versions("logbrew/sdk")(
                {"packages": {"logbrew/sdk": [{"version": "0.1.0"}]}}
            ),
        )
        self.assertIn("0.1.0", check_registry_publication.crates_versions({"crate": {"newest_version": "0.1.0"}}))
        self.assertIn(
            "0.1.0",
            check_registry_publication.crates_versions('{"vers":"0.1.0","yanked":false}\n'),
        )
        self.assertNotIn(
            "0.1.0",
            check_registry_publication.crates_versions('{"vers":"0.1.0","yanked":true}\n'),
        )
        self.assertIn(
            "0.1.0",
            check_registry_publication.maven_versions(
                """
                <metadata>
                  <versioning>
                    <latest>0.1.0</latest>
                    <release>0.1.0</release>
                    <versions>
                      <version>0.1.0</version>
                    </versions>
                  </versioning>
                </metadata>
                """
            ),
        )

    def test_default_all_target_verifies_only_publishable_oidc_registries(self) -> None:
        args = argparse.Namespace(
            target=["all"],
            include_unity_npm=False,
            include_pypi_extras=False,
            include_crates=False,
            include_packagist=False,
            include_maven=False,
            include_openupm=False,
            include_go=False,
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("@logbrew/sdk", labels)
        self.assertIn("logbrew-sdk", labels)
        self.assertIn("LogBrew", labels)
        self.assertNotIn("logbrew-fastapi", labels)
        self.assertNotIn("logbrew", labels)
        self.assertNotIn("logbrew/sdk", labels)
        self.assertNotIn("co.logbrew:logbrew-sdk", labels)
        self.assertNotIn("co.logbrew.unity", labels)

    def test_include_flags_add_guarded_registries(self) -> None:
        args = argparse.Namespace(
            target=["all"],
            include_unity_npm=True,
            include_pypi_extras=True,
            include_crates=True,
            include_packagist=True,
            include_maven=True,
            include_openupm=True,
            include_go=True,
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("co.logbrew.unity", labels)
        self.assertIn("logbrew-fastapi", labels)
        self.assertIn("logbrew-django", labels)
        self.assertIn("logbrew", labels)
        self.assertIn("logbrew/sdk", labels)
        self.assertIn("co.logbrew:logbrew-sdk", labels)

    def test_validate_check_passes_when_expected_version_is_found(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "example",
            "https://example.test/package",
            lambda payload: {payload["version"]},
        )

        failures = check_registry_publication.validate_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            retries=0,
            retry_delay=0.0,
            fetcher=lambda _url, _timeout: {"version": "0.1.0"},
        )

        self.assertEqual(failures, [])

    def test_validate_check_reports_missing_version(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "example",
            "https://example.test/package",
            lambda payload: {payload["version"]},
        )

        failures = check_registry_publication.validate_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            retries=0,
            retry_delay=0.0,
            fetcher=lambda _url, _timeout: {"version": "0.2.0"},
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("expected one of", failures[0])

    def test_validate_check_reports_http_failure(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "example",
            "https://example.test/package",
            lambda _payload: set(),
        )

        def failing_fetcher(_url: str, _timeout: float) -> Any:
            raise urllib.error.HTTPError("https://example.test/package", 404, "not found", {}, None)

        failures = check_registry_publication.validate_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            retries=0,
            retry_delay=0.0,
            fetcher=failing_fetcher,
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("HTTP 404", failures[0])

    def test_go_module_version_uses_go_semver_prefix(self) -> None:
        self.assertEqual(check_registry_publication.go_module_version("0.1.0"), "v0.1.0")
        self.assertEqual(check_registry_publication.go_module_version("v0.1.0"), "v0.1.0")

    def test_crates_index_path_matches_sparse_index_layout(self) -> None:
        self.assertEqual(check_registry_publication.crates_index_path("a"), "1/a")
        self.assertEqual(check_registry_publication.crates_index_path("ab"), "2/ab")
        self.assertEqual(check_registry_publication.crates_index_path("abc"), "3/a/abc")
        self.assertEqual(check_registry_publication.crates_index_path("logbrew"), "lo/gb/logbrew")


if __name__ == "__main__":
    unittest.main()
