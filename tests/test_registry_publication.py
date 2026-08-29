from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_registry_publication.py"
RELEASE_METADATA_PATH = ROOT / "scripts" / "check_release_metadata.py"


def load_module(module_name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(module_name, path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


check_release_metadata = load_module("check_release_metadata", RELEASE_METADATA_PATH)
check_registry_publication = load_module("check_registry_publication", MODULE_PATH)


class RegistryPublicationTests(unittest.TestCase):
    def test_nuget_catalog_includes_httpclient(self) -> None:
        self.assertIn("LogBrew.HttpClient", check_registry_publication.NUGET_PACKAGES)
        args = argparse.Namespace(
            target=["nuget"],
            npm_package=[],
            include_unity_npm=False,
            include_pypi_extras=False,
            include_crates=False,
            include_packagist=False,
            include_maven=False,
            include_openupm=False,
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("LogBrew.HttpClient", labels)

    def test_nuget_version_overrides_restrict_collision_preflight(self) -> None:
        args = check_registry_publication.parse_args(
            [
                "--target",
                "nuget",
                "--expect-absent",
                "--nuget-version",
                "LogBrew=0.1.5",
                "--nuget-version",
                "LogBrew.HttpClient=0.1.0",
            ]
        )
        observed: list[str] = []
        original_validate_absent_check = check_registry_publication.validate_absent_check

        def fake_validate_absent_check(check, forbidden, timeout, fetcher=None):  # type: ignore[no-untyped-def]
            observed.append(check.label)
            return []

        try:
            check_registry_publication.validate_absent_check = fake_validate_absent_check
            failures = check_registry_publication.validate(args)
        finally:
            check_registry_publication.validate_absent_check = original_validate_absent_check

        self.assertEqual(failures, [])
        self.assertEqual(observed, ["LogBrew", "LogBrew.HttpClient"])

    def test_nuget_without_version_overrides_checks_the_full_catalog(self) -> None:
        args = check_registry_publication.parse_args(["--target", "nuget"])

        labels = [check.label for check in check_registry_publication.checks_for(args)]

        self.assertEqual(labels, list(check_registry_publication.NUGET_PACKAGES))

    def test_nuget_version_overrides_reject_unknown_and_duplicate_packages(self) -> None:
        invalid_versions = (
            ["Unknown.Package=0.1.0"],
            ["LogBrew=0.1.5", "LogBrew=0.1.5"],
            ["LogBrew.OpenTelemetry=0.1.1"],
        )
        for versions in invalid_versions:
            arguments = ["--target", "nuget"]
            for version in versions:
                arguments.extend(("--nuget-version", version))
            with self.subTest(versions=versions):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        check_registry_publication.parse_args(arguments)

    def test_extracts_versions_from_supported_registry_shapes(self) -> None:
        self.assertIn("0.1.0", check_registry_publication.npm_versions({"dist-tags": {"latest": "0.1.0"}}))
        self.assertEqual(
            check_registry_publication.npm_provenance_versions(
                {
                    "version": "0.1.0",
                    "dist": {"attestations": {
                        "url": "https://registry.npmjs.org/-/npm/v1/attestations/@logbrew%2fsdk@0.1.0",
                        "provenance": {"predicateType": "https://slsa.dev/provenance/v1"},
                    }},
                }
            ),
            {"0.1.0"},
        )
        self.assertEqual(check_registry_publication.npm_provenance_versions({"version": "0.1.0"}), set())
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

    def test_default_all_target_verifies_only_released_packages(self) -> None:
        args = argparse.Namespace(
            target=["all"],
            include_unity_npm=False,
            include_pypi_extras=False,
            include_crates=False,
            include_packagist=False,
            include_maven=False,
            include_openupm=False,
            include_go=False,
            npm_package=[],
            npm_versions={},
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("@logbrew/sdk", labels)
        self.assertIn("@logbrew/bullmq", labels)
        self.assertIn("@logbrew/kafkajs", labels)
        self.assertIn("@logbrew/amqplib", labels)
        self.assertIn("@logbrew/aws-sqs", labels)
        self.assertIn("logbrew-sdk", labels)
        self.assertIn("LogBrew", labels)
        self.assertIn("LogBrew.StackExchangeRedis", labels)
        self.assertNotIn("@logbrew/prisma", labels)
        self.assertNotIn("LogBrew.OpenTelemetry", labels)
        self.assertNotIn("logbrew-fastapi", labels)
        self.assertNotIn("logbrew", labels)
        self.assertNotIn("logbrew/sdk", labels)
        self.assertNotIn("co.logbrew:logbrew-sdk", labels)
        self.assertNotIn("co.logbrew.unity", labels)

    def test_released_package_sets_exclude_unpublished_packages(self) -> None:
        self.assertEqual(
            set(check_release_metadata.JS_PACKAGES.values())
            - {"@logbrew/prisma"},
            set(check_registry_publication.NPM_PACKAGES),
        )
        self.assertEqual(
            check_release_metadata.NUGET_PACKAGES
            - {"LogBrew.OpenTelemetry"},
            set(check_registry_publication.NUGET_PACKAGES),
        )

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
            npm_package=[],
            npm_versions={},
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("co.logbrew.unity", labels)
        self.assertIn("logbrew-fastapi", labels)
        self.assertIn("logbrew-flask", labels)
        self.assertIn("logbrew-django", labels)
        self.assertIn("logbrew", labels)
        self.assertIn("logbrew/sdk", labels)
        self.assertIn("co.logbrew:logbrew-sdk", labels)

    def test_family_targets_use_their_release_versions_by_default(self) -> None:
        original_validate_check = check_registry_publication.validate_check
        for target, label, version in (
            ("rubygems", "logbrew-sdk", check_release_metadata.RUBYGEMS_VERSION),
            ("packagist", "logbrew/sdk", check_release_metadata.PACKAGIST_VERSION),
        ):
            observed: dict[str, set[str]] = {}

            def fake_validate_check(check, expected, timeout, retries=0, retry_delay=5.0, fetcher=None):  # type: ignore[no-untyped-def]
                observed[check.label] = expected
                return []

            try:
                check_registry_publication.validate_check = fake_validate_check
                failures = check_registry_publication.validate(
                    check_registry_publication.parse_args(["--target", target])
                )
            finally:
                check_registry_publication.validate_check = original_validate_check

            with self.subTest(target=target):
                self.assertEqual(failures, [])
                self.assertEqual(
                    observed[label],
                    check_registry_publication.expected_versions(version),
                )

    def test_npm_package_filter_limits_npm_registry_checks(self) -> None:
        args = argparse.Namespace(
            target=["npm"],
            include_unity_npm=False,
            include_pypi_extras=False,
            include_crates=False,
            include_packagist=False,
            include_maven=False,
            include_openupm=False,
            include_go=False,
            npm_package=["@logbrew/nestjs"],
            npm_versions={},
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertEqual({"@logbrew/nestjs"}, labels)

    def test_npm_version_overrides_limit_npm_registry_checks(self) -> None:
        args = check_registry_publication.parse_args(
            [
                "--target",
                "all",
                "--npm-version",
                "@logbrew/sdk=0.1.4",
                "--npm-version",
                "@logbrew/browser=0.1.1",
            ]
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertIn("@logbrew/sdk", labels)
        self.assertIn("@logbrew/browser", labels)
        self.assertNotIn("@logbrew/angular", labels)
        self.assertNotIn("@logbrew/prisma", labels)

    def test_maven_artifact_filter_limits_maven_registry_checks(self) -> None:
        args = argparse.Namespace(
            target=["maven"],
            include_unity_npm=False,
            include_pypi_extras=False,
            include_crates=False,
            include_packagist=False,
            include_maven=False,
            include_openupm=False,
            include_go=False,
            npm_package=[],
            maven_artifact=["logbrew-sdk", "logbrew-kotlin"],
            npm_versions={},
        )

        labels = {check.label for check in check_registry_publication.checks_for(args)}

        self.assertEqual({"co.logbrew:logbrew-sdk", "co.logbrew:logbrew-kotlin"}, labels)

    def test_maven_plan_scopes_selected_and_external_dependency_checks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plan_path = Path(tmp) / "plan.json"
            plan_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "selected": [
                            {
                                "artifactId": "logbrew-kotlin-okhttp",
                                "coordinate": "co.logbrew:logbrew-kotlin-okhttp",
                                "packageDir": "kotlin/logbrew-kotlin-okhttp",
                                "version": "0.1.2",
                            }
                        ],
                        "externalDependencies": [
                            {
                                "artifactId": "logbrew-kotlin",
                                "coordinate": "co.logbrew:logbrew-kotlin",
                                "version": "0.1.1",
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            selected = check_registry_publication.parse_args(
                [
                    "--target",
                    "maven",
                    "--maven-plan",
                    str(plan_path),
                    "--maven-plan-scope",
                    "selected",
                ]
            )
            dependencies = check_registry_publication.parse_args(
                [
                    "--target",
                    "maven",
                    "--maven-plan",
                    str(plan_path),
                    "--maven-plan-scope",
                    "dependencies",
                ]
            )

        self.assertEqual(selected.maven_artifact, ["logbrew-kotlin-okhttp"])
        self.assertEqual(
            selected.maven_versions,
            {"co.logbrew:logbrew-kotlin-okhttp": "0.1.2"},
        )
        self.assertEqual(dependencies.maven_artifact, ["logbrew-kotlin"])
        self.assertEqual(
            dependencies.maven_versions,
            {"co.logbrew:logbrew-kotlin": "0.1.1"},
        )

    def test_maven_registry_versions_are_exact_without_tag_prefix_aliases(self) -> None:
        check = check_registry_publication.maven_check("logbrew-sdk")

        self.assertEqual(
            check_registry_publication.registry_expected_versions(check, "0.1.2"),
            {"0.1.2"},
        )

    def test_maven_collision_preflight_requires_the_selected_release_plan(self) -> None:
        for arguments in (
            ["--target", "maven", "--expect-absent"],
            [
                "--target",
                "maven",
                "--expect-absent",
                "--maven-plan",
                "unused.json",
                "--maven-plan-scope",
                "dependencies",
            ],
        ):
            with self.subTest(arguments=arguments):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        check_registry_publication.parse_args(arguments)

    def test_parse_package_versions_for_each_family(self) -> None:
        cases = (
            (
                "@logbrew/nestjs=0.1.1",
                None,
                "npm",
                {"@logbrew/nestjs": "0.1.1"},
            ),
            (
                "logbrew-fastapi=0.1.2",
                check_registry_publication.PYPI_PACKAGES
                + check_registry_publication.PYPI_EXTRA_PACKAGES,
                "PyPI",
                {"logbrew-fastapi": "0.1.2"},
            ),
            (
                "LogBrew.StackExchangeRedis=0.1.1",
                check_registry_publication.NUGET_PACKAGES,
                "NuGet",
                {"LogBrew.StackExchangeRedis": "0.1.1"},
            ),
            (
                "co.logbrew:logbrew-sdk=0.1.0",
                check_registry_publication.MAVEN_PACKAGE_LABELS,
                "Maven",
                {"co.logbrew:logbrew-sdk": "0.1.0"},
            ),
        )
        for raw, allowed, family, expected in cases:
            kwargs = {} if allowed is None else {"allowed_packages": allowed, "package_family": family}
            with self.subTest(family=family):
                self.assertEqual(
                    check_registry_publication.parse_package_versions([raw], **kwargs),
                    expected,
                )

    def test_success_summary_reports_each_family_version(self) -> None:
        cases = (
            (
                "npm",
                "0.1.0",
                {"npm_versions": {"@logbrew/nestjs": "0.1.1"}},
                ("@logbrew/nestjs@0.1.1",),
            ),
            (
                "pypi",
                "0.1.1",
                {
                    "pypi_versions": {
                        "logbrew-fastapi": "0.1.2",
                        "logbrew-flask": "0.1.0",
                        "logbrew-django": "0.1.2",
                    }
                },
                (
                    "logbrew-fastapi@0.1.2",
                    "logbrew-flask@0.1.0",
                    "logbrew-django@0.1.2",
                ),
            ),
            (
                "nuget",
                "0.1.0",
                {"nuget_versions": {"LogBrew": "0.1.1"}},
                ("LogBrew@0.1.1",),
            ),
            (
                "rubygems",
                "0.1.0",
                {},
                (f"logbrew-sdk@{check_release_metadata.RUBYGEMS_VERSION}",),
            ),
            (
                "packagist",
                "0.1.0",
                {},
                (f"logbrew/sdk@{check_release_metadata.PACKAGIST_VERSION}",),
            ),
            (
                "maven",
                "0.1.0",
                {"maven_versions": {"co.logbrew:logbrew-sdk": "0.1.0"}},
                ("co.logbrew:logbrew-sdk@0.1.0",),
            ),
        )
        for target, version, overrides, identities in cases:
            version_maps = {
                "npm_versions": {},
                "pypi_versions": {},
                "nuget_versions": {},
                "maven_versions": {},
            }
            version_maps.update(overrides)
            args = argparse.Namespace(
                target=[target],
                version=version,
                **version_maps,
            )
            summary = check_registry_publication.success_summary(args)
            with self.subTest(target=target):
                self.assertIn(f"public registry versions ok for {target} at {version}", summary)
                for identity in identities:
                    self.assertIn(identity, summary)

    def test_same_named_packages_use_family_scoped_versions(self) -> None:
        args = check_registry_publication.parse_args(
            [
                "--target",
                "all",
                "--version",
                "0.1.4",
                "--pypi-version",
                "logbrew-sdk=0.1.4",
                "--include-packagist",
            ]
        )
        observed: dict[tuple[str, str], set[str]] = {}
        original_validate_check = check_registry_publication.validate_check

        def fake_validate_check(check, expected, timeout, retries=0, retry_delay=5.0, fetcher=None):  # type: ignore[no-untyped-def]
            observed[(getattr(check, "family", ""), check.label)] = expected
            return []

        try:
            check_registry_publication.validate_check = fake_validate_check
            failures = check_registry_publication.validate(args)
        finally:
            check_registry_publication.validate_check = original_validate_check

        self.assertEqual(failures, [])
        self.assertEqual(observed[("pypi", "logbrew-sdk")], {"0.1.4", "v0.1.4"})
        self.assertEqual(
            observed[("rubygems", "logbrew-sdk")],
            check_registry_publication.expected_versions(check_release_metadata.RUBYGEMS_VERSION),
        )
        self.assertEqual(
            observed[("packagist", "logbrew/sdk")],
            check_registry_publication.expected_versions(check_release_metadata.PACKAGIST_VERSION),
        )

    def test_same_named_packages_use_family_scoped_defaults(self) -> None:
        args = check_registry_publication.parse_args(
            [
                "--target",
                "all",
                "--version",
                "0.1.4",
                "--include-packagist",
            ]
        )
        observed: dict[tuple[str, str], set[str]] = {}
        original_validate_check = check_registry_publication.validate_check

        def fake_validate_check(check, expected, timeout, retries=0, retry_delay=5.0, fetcher=None):  # type: ignore[no-untyped-def]
            observed[(getattr(check, "family", ""), check.label)] = expected
            return []

        try:
            check_registry_publication.validate_check = fake_validate_check
            failures = check_registry_publication.validate(args)
        finally:
            check_registry_publication.validate_check = original_validate_check

        self.assertEqual(failures, [])
        self.assertEqual(observed[("pypi", "logbrew-sdk")], {"0.1.4", "v0.1.4"})
        self.assertEqual(
            observed[("rubygems", "logbrew-sdk")],
            check_registry_publication.expected_versions(check_release_metadata.RUBYGEMS_VERSION),
        )
        self.assertEqual(
            observed[("packagist", "logbrew/sdk")],
            check_registry_publication.expected_versions(check_release_metadata.PACKAGIST_VERSION),
        )

    def test_cross_family_verify_requires_exact_released_package_sets(self) -> None:
        npm_versions = [
            f"{package_name}=0.1.0"
            for package_name in check_registry_publication.NPM_PACKAGES
        ]
        nuget_versions = [
            f"{package_name}=0.1.0"
            for package_name in check_registry_publication.NUGET_PACKAGES
        ]

        def arguments(
            npm: list[str],
            nuget: list[str],
        ) -> list[str]:
            values = [
                "--target",
                "all",
                "--require-released-package-set",
            ]
            for package_version in npm:
                values.extend(("--npm-version", package_version))
            for package_version in nuget:
                values.extend(("--nuget-version", package_version))
            return values

        parsed = check_registry_publication.parse_args(
            arguments(npm_versions, nuget_versions)
        )
        self.assertEqual(set(parsed.npm_versions), set(check_registry_publication.NPM_PACKAGES))
        self.assertEqual(
            set(parsed.nuget_versions),
            set(check_registry_publication.NUGET_PACKAGES),
        )

        for invalid in (
            arguments(npm_versions[:-1], nuget_versions),
            arguments(npm_versions, nuget_versions[:-1]),
            ["--target", "all", "--require-released-package-set"],
        ):
            with self.subTest(invalid=invalid):
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit):
                        check_registry_publication.parse_args(invalid)

    def test_cross_family_verify_requires_selected_unity_exactly_once(self) -> None:
        arguments = [
            "--target",
            "all",
            "--require-released-package-set",
            "--include-unity-npm",
        ]
        for package_name in check_registry_publication.NPM_VERSION_PACKAGES:
            arguments.extend(("--npm-version", f"{package_name}=0.1.0"))
        for package_name in check_registry_publication.NUGET_PACKAGES:
            arguments.extend(("--nuget-version", f"{package_name}=0.1.0"))

        parsed = check_registry_publication.parse_args(arguments)
        labels = [
            check.label
            for check in check_registry_publication.checks_for(parsed)
            if check.family == "npm"
        ]

        self.assertEqual(labels.count("co.logbrew.unity"), 1)

        missing_unity = [
            argument
            for index, argument in enumerate(arguments)
            if argument != "co.logbrew.unity=0.1.0"
            and not (
                argument == "--npm-version"
                and index + 1 < len(arguments)
                and arguments[index + 1] == "co.logbrew.unity=0.1.0"
            )
        ]
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                check_registry_publication.parse_args(missing_unity)

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

    def test_validate_check_does_not_retry_missing_registry_pages(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "example",
            "https://example.test/package",
            lambda _payload: set(),
        )
        attempts = 0

        def missing_fetcher(_url: str, _timeout: float) -> Any:
            nonlocal attempts
            attempts += 1
            raise urllib.error.HTTPError("https://example.test/package", 404, "not found", {}, None)

        failures = check_registry_publication.validate_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            retries=3,
            retry_delay=0.0,
            fetcher=missing_fetcher,
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(len(failures), 1)
        self.assertIn("HTTP 404", failures[0])

    def test_validate_check_does_not_retry_curl_missing_registry_pages(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "example",
            "https://example.test/package",
            lambda _payload: set(),
        )
        attempts = 0

        def missing_fetcher(_url: str, _timeout: float) -> Any:
            nonlocal attempts
            attempts += 1
            raise OSError("curl: (56) The requested URL returned error: 404")

        failures = check_registry_publication.validate_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            retries=3,
            retry_delay=0.0,
            fetcher=missing_fetcher,
        )

        self.assertEqual(attempts, 1)
        self.assertEqual(len(failures), 1)
        self.assertIn("404", failures[0])

    def test_validate_absent_check_rejects_existing_exact_version(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "LogBrew.HttpClient",
            "https://example.test/package",
            check_registry_publication.nuget_versions,
        )

        failures = check_registry_publication.validate_absent_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            fetcher=lambda _url, _timeout: {"versions": ["0.1.0"]},
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("already exists", failures[0])

    def test_validate_absent_check_accepts_other_versions(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "LogBrew.HttpClient",
            "https://example.test/package",
            check_registry_publication.nuget_versions,
        )

        failures = check_registry_publication.validate_absent_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            fetcher=lambda _url, _timeout: {"versions": ["0.0.9"]},
        )

        self.assertEqual(failures, [])

    def test_validate_absent_check_accepts_missing_package_page(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "LogBrew.HttpClient",
            "https://example.test/package",
            check_registry_publication.nuget_versions,
        )

        def missing_fetcher(_url: str, _timeout: float) -> Any:
            raise urllib.error.HTTPError("https://example.test/package", 404, "not found", {}, None)

        failures = check_registry_publication.validate_absent_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            fetcher=missing_fetcher,
        )

        self.assertEqual(failures, [])

    def test_validate_absent_check_rejects_malformed_registry_payload(self) -> None:
        check = check_registry_publication.RegistryCheck(
            "LogBrew.HttpClient",
            "https://example.test/package",
            check_registry_publication.nuget_versions,
        )

        failures = check_registry_publication.validate_absent_check(
            check,
            {"0.1.0"},
            timeout=1.0,
            fetcher=lambda _url, _timeout: {},
        )

        self.assertEqual(len(failures), 1)
        self.assertIn("availability check failed", failures[0])

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
