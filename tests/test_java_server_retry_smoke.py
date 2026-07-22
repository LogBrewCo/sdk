from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_server_retry_smoke.sh"


class JavaServerRetrySmokeTests(unittest.TestCase):
    def test_smoke_uses_installed_jar_and_strict_loopback_contract(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('jar_path="$tmp_dir/logbrew-sdk-$package_version.jar"', script)
        self.assertIn('exchange.getResponseHeaders().add("Retry-After", "1")', script)
        self.assertIn("IMF_FIXDATE.format(Instant.now().plusSeconds(10L))", script)
        self.assertIn('exchange.getResponseHeaders().add("Retry-After", "1, 2")', script)
        self.assertIn("byte-identical failed prefix", script)
        self.assertIn("terminal guidance ignored", script)
        self.assertIn("health field is not fixed and content-free", script)
        self.assertIn("observed delay", script)
        self.assertIn("delivery scheduler teardown failed", script)
        self.assertIn('shasum -a 256 "$jar_path"', script)
        self.assertNotIn("api.logbrew.co", script)


if __name__ == "__main__":
    unittest.main()
