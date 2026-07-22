from pathlib import Path
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE = REPO_ROOT / "scripts" / "real_user_java_persistent_delivery_smoke.sh"


class JavaPersistentDeliverySmokeTests(unittest.TestCase):
    def test_smoke_uses_installed_jar_and_two_process_hard_exit(self) -> None:
        script = SMOKE.read_text(encoding="utf-8")

        self.assertIn('jar_path="$tmp_dir/logbrew-sdk-$package_version.jar"', script)
        self.assertIn('tmp_dir="$(cd "$tmp_dir" && pwd -P)"', script)
        self.assertIn('Runtime.getRuntime().halt(0)', script)
        self.assertIn('Main write "$key_file" "$store_dir"', script)
        self.assertIn('Main recover "$key_file" "$store_dir" "$preview_sha256"', script)
        self.assertIn('HIGH_VOLUME_EVENTS = 1500', script)
        self.assertIn('sha256(preview)', script)
        self.assertIn('sha256(recoveredPreview)', script)
        self.assertIn('assertStableRecoveredIds(recoveredPreview)', script)
        self.assertIn('payload.get("previewSha256", "")', script)
        self.assertIn('"recoveredPreviewSha256": sys.argv[2]', script)
        self.assertIn('retainedAfterPrefixFailure\\\":501', script)
        self.assertIn('byte-identical 503 to 202 retry', script)
        self.assertIn('PosixFilePermissions.fromString("rwx------")', script)
        self.assertIn('PosixFilePermissions.fromString("rw-------")', script)
        self.assertIn('persistence privacy check failed', script)
        self.assertNotIn('https://api.logbrew.com', script)


if __name__ == "__main__":
    unittest.main()
