from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_automatic_delivery_smoke.sh"


class JavaAutomaticDeliverySmokeTests(unittest.TestCase):
    def test_smoke_uses_installed_jar_and_strict_restart_loopback_contract(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('jar_path="$tmp_dir/logbrew-sdk-$package_version.jar"', script)
        self.assertIn("Runtime.getRuntime().halt(0)", script)
        self.assertIn('Main persist "$key_file" "$store_dir" "$package_version"', script)
        self.assertIn("restart preview digest", script)
        self.assertIn("503 retry body identity", script)
        self.assertIn("failed prefix excludes later capture", script)
        self.assertIn("authentication pause", script)
        self.assertIn("terminal recovery body identity", script)
        self.assertIn("health privacy", script)
        self.assertIn("delivery scheduler teardown", script)
        self.assertIn('assertEquals("/v1/events", request.path', script)
        self.assertIn('assertEquals("Bearer " + API_KEY, request.authorization', script)
        self.assertIn("automatic persistence privacy check failed", script)
        self.assertIn('shasum -a 256 "$jar_path"', script)
        self.assertNotIn("api.logbrew.co", script)


if __name__ == "__main__":
    unittest.main()
