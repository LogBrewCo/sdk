from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "real_user_python_automatic_delivery_smoke.sh"


class PythonAutomaticDeliverySmokeTests(unittest.TestCase):
    def test_installed_smoke_keeps_the_automatic_delivery_boundary(self) -> None:
        text = SMOKE.read_text(encoding="utf-8")

        for required in (
            '"$python" -m build "$tmp_dir/logbrew_py" --wheel',
            '"$python" -m pip install --quiet --no-index "$wheel_path"',
            "delivery_queue_threshold=1",
            'automatic_delivery=False',
            'paused_reason"] != "rate_limit"',
            "IntakeState.bodies[0] != IntakeState.bodies[1]",
            "client.delivery_health()",
            "client.shutdown()",
            "subprocess.run(",
            "timeout=20",
        ):
            with self.subTest(required=required):
                self.assertIn(required, text)

    def test_installed_smoke_keeps_health_privacy_assertions(self) -> None:
        text = SMOKE.read_text(encoding="utf-8")

        self.assertIn('if set(health) != expected_keys:', text)
        self.assertIn('if forbidden in serialized_health:', text)
        self.assertIn('raise AssertionError("delivery health exposed request content")', text)


if __name__ == "__main__":
    unittest.main()
