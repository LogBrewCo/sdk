from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "nuget_release_plan.py"


class NugetReleasePlanTests(unittest.TestCase):
    def create_plan(self, raw_selection: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "plan.json"
            environment = os.environ.copy()
            environment["NUGET_PACKAGES_INPUT"] = raw_selection
            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "create",
                    "--root",
                    str(ROOT),
                    "--packages-env",
                    "NUGET_PACKAGES_INPUT",
                    "--output",
                    str(output),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                env=environment,
            )
            if result.returncode == 0:
                result.plan = json.loads(output.read_text(encoding="utf-8"))  # type: ignore[attr-defined]
            return result

    def test_empty_selection_preserves_all_package_semantics(self) -> None:
        result = self.create_plan("")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.plan["selectionMode"], "all")  # type: ignore[attr-defined]
        self.assertEqual(
            [entry["packageId"] for entry in result.plan["selected"]],  # type: ignore[attr-defined]
            [
                "LogBrew",
                "LogBrew.AspNetCore",
                "LogBrew.EntityFrameworkCore",
                "LogBrew.HttpClient",
                "LogBrew.StackExchangeRedis",
                "LogBrew.OpenTelemetry",
            ],
        )

    def test_selected_packages_are_typed_and_canonicalized_in_catalog_order(self) -> None:
        result = self.create_plan("LogBrew.HttpClient, LogBrew")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            result.plan,  # type: ignore[attr-defined]
            {
                "schemaVersion": 1,
                "selectionMode": "selected",
                "selected": [
                    {
                        "packageId": "LogBrew",
                        "projectPath": "dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
                        "version": "0.1.5",
                        "versionOutput": "core_version",
                    },
                    {
                        "packageId": "LogBrew.HttpClient",
                        "projectPath": "dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
                        "version": "0.1.0",
                        "versionOutput": "httpclient_version",
                    },
                ],
            },
        )

    def test_invalid_dispatch_selections_fail_closed_without_reflecting_input(self) -> None:
        for raw_selection in (
            "Unknown.Package",
            "LogBrew",
            "LogBrew.HttpClient",
            "LogBrew.AspNetCore",
            "LogBrew,LogBrew.AspNetCore",
            "LogBrew,LogBrew",
            "LogBrew,,LogBrew.HttpClient",
            "LogBrew,",
            "logbrew",
            "LogBrew\nLogBrew.HttpClient",
            "LogBrew\rLogBrew.HttpClient",
            'LogBrew; printf "unsafe"',
            "LogBrew$(id)",
        ):
            with self.subTest(raw_selection=raw_selection):
                result = self.create_plan(raw_selection)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("invalid NuGet package selection", result.stderr)
                self.assertNotIn(raw_selection, result.stderr)

    def test_saved_plan_validation_rejects_metadata_drift(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "plan.json"
            environment = os.environ.copy()
            environment["NUGET_PACKAGES_INPUT"] = "LogBrew,LogBrew.HttpClient"
            create = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "create",
                    "--root",
                    str(ROOT),
                    "--packages-env",
                    "NUGET_PACKAGES_INPUT",
                    "--output",
                    str(output),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                env=environment,
            )
            self.assertEqual(create.returncode, 0, create.stderr)
            payload = json.loads(output.read_text(encoding="utf-8"))
            payload["selected"][0]["version"] = "9.9.9"
            output.write_text(json.dumps(payload), encoding="utf-8")

            validate = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "validate",
                    "--root",
                    str(ROOT),
                    "--plan",
                    str(output),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

        self.assertNotEqual(validate.returncode, 0)
        self.assertIn("invalid NuGet release plan", validate.stderr)

    def test_saved_selected_plan_rejects_non_target_package(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "plan.json"
            payload = {
                "schemaVersion": 1,
                "selectionMode": "selected",
                "selected": [
                    {
                        "packageId": "LogBrew.AspNetCore",
                        "projectPath": (
                            "dotnet/logbrew-dotnet/src/LogBrew.AspNetCore/"
                            "LogBrew.AspNetCore.csproj"
                        ),
                        "version": "0.1.0",
                        "versionOutput": "aspnetcore_version",
                    },
                ],
            }
            output.write_text(json.dumps(payload), encoding="utf-8")

            validate = subprocess.run(
                [
                    "python3",
                    str(SCRIPT),
                    "validate",
                    "--root",
                    str(ROOT),
                    "--plan",
                    str(output),
                ],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
            )

        self.assertNotEqual(validate.returncode, 0)
        self.assertIn("invalid NuGet release plan", validate.stderr)

    def test_canonicalize_emits_only_validated_single_line_selection(self) -> None:
        environment = os.environ.copy()
        environment["NUGET_PACKAGES_INPUT"] = "LogBrew.HttpClient, LogBrew"
        result = subprocess.run(
            [
                "python3",
                str(SCRIPT),
                "canonicalize",
                "--packages-env",
                "NUGET_PACKAGES_INPUT",
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=environment,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "LogBrew,LogBrew.HttpClient\n")


if __name__ == "__main__":
    unittest.main()
