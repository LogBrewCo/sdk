from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "real_user_dotnet_smoke.sh"


class DotNetInstalledArtifactActivitySourceTests(unittest.TestCase):
    def test_smoke_runs_activity_source_listener_packaged_example(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('"examples/ActivitySourceListenerTelemetry.cs"', script)
        self.assertIn(
            'run_packaged_example ActivitySourceListenerTelemetry.cs PackagedActivitySourceListener '
            '"$tmp_dir/packaged-activity-source-listener.stdout.json" '
            '"$tmp_dir/packaged-activity-source-listener.stderr.json"',
            script,
        )
        self.assertIn(
            'python3 "$repo_root/scripts/check_dotnet_activity_source_listener_payload.py" '
            '"$tmp_dir/packaged-activity-source-listener.stdout.json" '
            '"$tmp_dir/packaged-activity-source-listener.stderr.json" >/dev/null',
            script,
        )
        self.assertLess(
            script.index("run_packaged_example ActivityTraceCorrelation.cs"),
            script.index("run_packaged_example ActivitySourceListenerTelemetry.cs"),
        )
        self.assertLess(
            script.index("run_packaged_example ActivitySourceListenerTelemetry.cs"),
            script.index("run_packaged_example DbCommandTelemetry.cs"),
        )


if __name__ == "__main__":
    unittest.main()
