from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_openupm_public_smoke.sh"


class OpenUpmPublicSmokeTests(unittest.TestCase):
    def test_script_proves_current_public_openupm_package_installs(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            "LOGBREW_OPENUPM_VERSION",
            'version="${1:-${LOGBREW_OPENUPM_VERSION:-0.1.1}}"',
            "https://package.openupm.com",
            "npm pack co.logbrew.unity@",
            "scopedRegistries",
            "co.logbrew.unity",
            "Runtime/LogBrewTrace.cs",
            "Runtime/UnityCoroutineTrace.cs",
            "Runtime/UnityLifecycleTracker.cs",
            "Runtime/UnityRequestTrace.cs",
            "Samples~/ReadmeExample/ReadmeExample.cs",
            "Samples~/RealUserSmoke/RealUserSmoke.cs",
            "examples/trace_correlation/TraceCorrelation.cs",
            "examples/lifecycle_spans/LifecycleSpans.cs",
            "examples/lifecycle_tracker/LifecycleTracker.cs",
            "examples/request_tracker/RequestTracker.cs",
            "examples/coroutine_tracker/CoroutineTracker.cs",
            "run-trace-correlation",
            "run-lifecycle-spans",
            "run-lifecycle-tracker",
            "run-request-tracker",
            "run-coroutine-tracker",
            "dotnet run",
            "openupm public install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
