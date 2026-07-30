from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReleaseArtifactReceiptModeTests(unittest.TestCase):
    def test_changed_family_smokes_bind_install_and_attest_exact_artifacts(self) -> None:
        scripts = {
            "crates": "real_user_cratesio_public_smoke.sh",
            "go": "real_user_go_public_module_smoke.sh",
            "maven": "real_user_maven_central_public_smoke.sh",
            "npm-nestjs": "real_user_nestjs_public_registry_smoke.sh",
            "nuget": "real_user_dotnet_selected_public_nuget_smoke.sh",
            "packagist": "real_user_packagist_public_smoke.sh",
            "pypi": "real_user_python_public_pypi_smoke.sh",
            "rubygems": "real_user_rubygems_public_smoke.sh",
            "swiftpm": "real_user_swiftpm_public_smoke.sh",
        }
        for family, script_name in scripts.items():
            with self.subTest(family=family):
                body = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
                self.assertIn('LOGBREW_RELEASE_RECEIPT_MODE', body)
                self.assertIn('release_artifact_receipt.py" bind', body)
                self.assertIn(f'--family "{family}"', body)
                self.assertIn('release_artifact_receipt.py" attest', body)
                self.assertIn('run_receipt_smoke', body)

    def test_normal_registry_mode_remains_the_default(self) -> None:
        for script_name in (
            "real_user_cratesio_public_smoke.sh",
            "real_user_go_public_module_smoke.sh",
            "real_user_maven_central_public_smoke.sh",
            "real_user_nestjs_public_registry_smoke.sh",
            "real_user_dotnet_selected_public_nuget_smoke.sh",
            "real_user_packagist_public_smoke.sh",
            "real_user_python_public_pypi_smoke.sh",
            "real_user_rubygems_public_smoke.sh",
            "real_user_swiftpm_public_smoke.sh",
        ):
            with self.subTest(script=script_name):
                body = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
                self.assertIn('receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"', body)

    def test_nuget_receipt_installs_the_bound_packages_from_canonical_hard_links(self) -> None:
        body = (
            ROOT / "scripts" / "real_user_dotnet_selected_public_nuget_smoke.sh"
        ).read_text(encoding="utf-8")

        self.assertIn(
            'ln "$bound/0.nupkg" "$source_dir/LogBrew.${core_version}.nupkg"',
            body,
        )
        self.assertIn('ln "$bound/1.nupkg"', body)
        self.assertIn(
            '"$source_dir/LogBrew.HttpClient.${httpclient_version}.nupkg"', body
        )
        self.assertIn('<add key="receipt" value="$source_dir" />', body)
        self.assertNotIn('<add key="receipt" value="$bound" />', body)
        self.assertIn(
            '"$control_root/scripts/check_nuget_release_receipt_provenance.py"',
            body,
        )
        self.assertNotIn(
            '"$repo_root/scripts/check_nuget_release_receipt_provenance.py"',
            body,
        )

    def test_nuget_exact_execution_reports_only_fixed_failure_stages(self) -> None:
        cases = (
            ("create", "project-create"),
            ("add-core", "core-reference"),
            ("add-httpclient", "httpclient-reference"),
            ("package-resolution", "package-resolution"),
            ("run", "consumer-execution"),
            ("provenance", "provenance-verification"),
        )
        for failure, expected_stage in cases:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as raw_tmp:
                root = Path(raw_tmp)
                source = root / "source"
                scripts = source / "scripts"
                artifacts = root / "artifacts"
                fake_bin = root / "bin"
                scripts.mkdir(parents=True)
                artifacts.mkdir()
                fake_bin.mkdir()
                (root / "plan.json").write_text("{}", encoding="utf-8")
                (artifacts / "LogBrew.0.1.5.nupkg").write_bytes(b"core")
                (artifacts / "LogBrew.HttpClient.0.1.0.nupkg").write_bytes(b"client")
                planner = scripts / "nuget_release_plan.py"
                planner.write_text(
                    """\
import sys

if "validate" in sys.argv:
    raise SystemExit(0)
format_name = sys.argv[sys.argv.index("--format") + 1]
if format_name == "versions":
    print("LogBrew=0.1.5")
    print("LogBrew.HttpClient=0.1.0")
elif format_name == "mode":
    print("selected")
else:
    raise SystemExit(2)
""",
                    encoding="utf-8",
                )
                provenance = scripts / "check_nuget_release_receipt_provenance.py"
                provenance.write_text(
                    """\
import os
import sys

if os.environ["FAIL_STAGE"] == "provenance":
    print("sensitive provenance details", file=sys.stderr)
    raise SystemExit(1)
""",
                    encoding="utf-8",
                )
                dotnet = fake_bin / "dotnet"
                dotnet.write_text(
                    """\
#!/usr/bin/env bash
set -eu
command_name="$1"
shift
stage="$command_name"
if [[ "$command_name" == "new" ]]; then
  stage="create"
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--output" ]]; then
      mkdir -p "$2"
      break
    fi
    shift
  done
elif [[ "$command_name" == "add" ]]; then
  stage="add-core"
  for argument in "$@"; do
    [[ "$argument" == "LogBrew.HttpClient" ]] && stage="add-httpclient"
  done
elif [[ "$command_name" == "re""store" ]]; then
  stage="package-resolution"
fi
if [[ "${FAIL_STAGE:-}" == "$stage" ]]; then
  echo "sensitive package-manager details" >&2
  exit 1
fi
""",
                    encoding="utf-8",
                )
                dotnet.chmod(0o755)
                environment = os.environ.copy()
                environment.update(
                    {
                        "FAIL_STAGE": failure,
                        "LOGBREW_RELEASE_SOURCE_ROOT": str(source),
                        "PATH": f"{fake_bin}{os.pathsep}{environment['PATH']}",
                        "TMPDIR": str(root),
                    }
                )
                result = subprocess.run(
                    [
                        "bash",
                        str(
                            ROOT
                            / "scripts"
                            / "real_user_dotnet_selected_public_nuget_smoke.sh"
                        ),
                        "--plan",
                        str(root / "plan.json"),
                        "--artifact-root",
                        str(artifacts),
                    ],
                    cwd=ROOT,
                    env=environment,
                    text=True,
                    capture_output=True,
                    check=False,
                )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(
                result.stderr,
                f"NuGet public artifact execution failed: {expected_stage}\n",
            )
            self.assertNotIn("sensitive", result.stderr)


if __name__ == "__main__":
    unittest.main()
