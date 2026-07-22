from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_confidentiality_scan.py"
SPEC = importlib.util.spec_from_file_location("check_confidentiality_scan", MODULE_PATH)
assert SPEC is not None
check_confidentiality_scan = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_confidentiality_scan)


class GoConfidentialityScanTests(unittest.TestCase):
    def test_allows_only_structured_go_url_host_name_call(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_dir = root / "go" / "logbrew"
            source_dir.mkdir(parents=True)
            api_member = "Host" + "name"
            disclosure = "host" + "name"
            (source_dir / "http_client_trace.go").write_text(
                f'host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(request.URL.{api_member}()), "."))\n'
                f'note := "production {disclosure} inventory"\n',
                encoding="utf-8",
            )

            failures = check_confidentiality_scan.validate(root)

        self.assertEqual(len(failures), 1)
        self.assertIn(f"production {disclosure} inventory", failures[0])


if __name__ == "__main__":
    unittest.main()
