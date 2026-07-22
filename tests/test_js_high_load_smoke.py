from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_js_high_load_smoke.sh"


class JsHighLoadSmokeTests(unittest.TestCase):
    def test_js_high_load_smoke_exists_and_exercises_installed_artifact_flow(self):
        text = SMOKE.read_text()

        self.assertIn("npm install", text)
        self.assertIn("node_modules/@logbrew/sdk", text)
        self.assertIn("node_modules/@logbrew/node", text)
        self.assertIn("node_modules/@logbrew/browser", text)
        self.assertIn("127.0.0.1", text)
        self.assertIn("const highVolumeLogs = 1500;", text)
        self.assertIn("maxBatchBytes", text)
        self.assertIn("maxBatchEvents", text)
        self.assertIn("pendingBytes()", text)
        self.assertIn("droppedEvents()", text)
        self.assertIn("stable retry body", text)
        self.assertIn("raceRequests", text)
        self.assertIn("retryAttempts", text)
        self.assertIn("shutdown", text)


if __name__ == "__main__":
    unittest.main()
