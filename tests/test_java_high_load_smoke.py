from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_high_load_smoke.sh"


class JavaHighLoadSmokeTests(unittest.TestCase):
    def test_java_high_load_smoke_exercises_installed_artifact_flow(self) -> None:
        script = SMOKE.read_text()

        self.assertIn("logbrew-sdk-0.1.0.jar", script)
        self.assertIn("javac -Xlint:all -Werror", script)
        self.assertIn("127.0.0.1", script)
        self.assertIn("HIGH_VOLUME_LOGS = 1500", script)
        self.assertIn("RETAINED_LOGS = 1000", script)
        self.assertIn("DeliveryOptions.builder()", script)
        self.assertIn("maxQueueBytes(queueByteLimit)", script)
        self.assertIn("maxBatchBytes(batchByteLimit)", script)
        self.assertIn("pendingEventBytes()", script)
        self.assertIn("droppedEventBytes()", script)
        self.assertIn("droppedEvents()", script)
        self.assertIn("EventDrop", script)
        self.assertIn("queue_overflow", script)
        self.assertIn("immutable retry body", script)
        self.assertIn("testAcceptedPrefixRetention", script)
        self.assertIn("retryAttempts", script)
        self.assertIn("failed shutdown reopens", script)
        self.assertIn("shutdown_error", script)


if __name__ == "__main__":
    unittest.main()
