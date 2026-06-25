from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_node_queue_high_load_smoke.sh"


class NodeQueueHighLoadSmokeTests(unittest.TestCase):
    def test_node_queue_high_load_smoke_exercises_installed_transport_flow(self):
        text = SMOKE.read_text()

        self.assertIn("npm install", text)
        self.assertIn("node_modules/@logbrew/sdk", text)
        self.assertIn("node_modules/@logbrew/node", text)
        self.assertIn("127.0.0.1", text)
        self.assertIn("const highVolumeQueueSpans = 1500;", text)
        self.assertIn("queueBatchOperationWithLogBrewSpan", text)
        self.assertIn("createNodeFetchTransport", text)
        self.assertIn("droppedEvents()", text)
        self.assertIn("retryAttempts", text)
        self.assertIn("shutdown", text)


if __name__ == "__main__":
    unittest.main()
