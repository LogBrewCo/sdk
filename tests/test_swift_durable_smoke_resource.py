from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import ci_changed_areas


ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "scripts" / "real_user_swift_build_executable.sh"
SMOKE = ROOT / "scripts" / "real_user_swift_smoke.sh"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"


class SwiftDurableSmokeResourceTests(unittest.TestCase):
    def test_builder_path_selects_the_swift_ci_area(self) -> None:
        relative_builder = BUILDER.relative_to(ROOT).as_posix()

        self.assertTrue(ci_changed_areas.classify([relative_builder])["swift"])

    def test_builder_compiles_once_with_one_job_and_returns_the_executable(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            fixture = Path(raw_tmp)
            fake_tools = fixture / "tools"
            binary_dir = fixture / "binary"
            consumer = fixture / "consumer"
            scratch = fixture / "scratch"
            invocations = fixture / "swift-invocations.txt"
            fake_tools.mkdir()
            binary_dir.mkdir()
            consumer.mkdir()

            swift = fake_tools / "swift"
            swift.write_text(
                """\
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SWIFT_INVOCATIONS"
if [[ " $* " == *" --show-bin-path "* ]]; then
  printf '%s\n' "$DURABLE_BINARY_DIRECTORY"
fi
""",
                encoding="utf-8",
            )
            swift.chmod(0o755)

            executable = binary_dir / "DurableSmoke"
            executable.write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            executable.chmod(0o755)

            environment = os.environ.copy()
            environment.update(
                {
                    "DURABLE_BINARY_DIRECTORY": str(binary_dir),
                    "PATH": f"{fake_tools}{os.pathsep}{environment['PATH']}",
                    "SWIFT_INVOCATIONS": str(invocations),
                }
            )

            result = subprocess.run(
                [
                    "bash",
                    str(BUILDER),
                    str(consumer),
                    str(scratch),
                    "DurableSmoke",
                ],
                cwd=ROOT,
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), str(executable))
            swift_calls = invocations.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(swift_calls), 2)
            self.assertIn("--jobs 1", swift_calls[0])
            self.assertIn("--product DurableSmoke", swift_calls[0])
            self.assertNotIn("--show-bin-path", swift_calls[0])
            self.assertIn("--show-bin-path", swift_calls[1])
            self.assertEqual(
                sum("--product DurableSmoke" in call for call in swift_calls),
                1,
            )

    def test_ci_smoke_owns_the_bounded_restart_runner(self) -> None:
        workflow = CI_WORKFLOW.read_text(encoding="utf-8")
        swift_job = workflow[
            workflow.index("  swift-checks:") : workflow.index("  objc-checks:")
        ]
        smoke = SMOKE.read_text(encoding="utf-8")
        durable_phase = smoke[smoke.index("installed durable restart") :]

        self.assertIn("run: bash scripts/real_user_swift_smoke.sh", swift_job)
        self.assertIn(
            'bash "$repo_root/scripts/real_user_swift_build_executable.sh"',
            durable_phase,
        )
        self.assertNotIn("swift run", durable_phase)
        write_process = durable_phase.index(
            '"$durable_binary" write "$durable_parent"'
        )
        persisted_scan = durable_phase.index(
            "if grep -R -q 'LOGBREW_API_KEY'"
        )
        recover_process = durable_phase.index(
            '"$durable_binary" recover "$durable_parent"'
        )
        self.assertLess(write_process, persisted_scan)
        self.assertLess(persisted_scan, recover_process)


if __name__ == "__main__":
    unittest.main()
