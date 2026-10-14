from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ReleaseArtifactReceiptModeTests(unittest.TestCase):
    def test_nuget_exact_execution_reports_only_fixed_failure_stages(self) -> None:
        self.assertTrue(Path(os.environ["LOGBREW_TOOLCHAIN_PROBE_BIN"]).is_file())
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
                artifacts = root / "artifacts"
                fake_bin = root / "bin"
                shutil.copytree(ROOT / "tools/toolchain-probe/testdata/nuget-release", source)
                artifacts.mkdir()
                fake_bin.mkdir()
                shutil.copyfile(source / "plan.json", root / "plan.json")
                (artifacts / "LogBrew.0.1.5.nupkg").write_bytes(b"core")
                (artifacts / "LogBrew.HttpClient.0.1.0.nupkg").write_bytes(b"client")
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
