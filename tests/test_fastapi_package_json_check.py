from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "check_fastapi_package_json.py"


class FastApiPackageJsonCheckTests(unittest.TestCase):
    def run_checker(
        self,
        document: object,
        *arguments: str,
        raw: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "document.json"
            path.write_text(raw if raw is not None else json.dumps(document), encoding="utf-8")
            return subprocess.run(
                [sys.executable, str(CHECKER), *arguments, str(path)],
                check=False,
                capture_output=True,
                text=True,
            )

    def test_event_kinds_accept_compact_and_pretty_documents(self) -> None:
        document = {"sdk": {}, "events": [{"type": "span"}, {"type": "issue"}]}

        compact = self.run_checker(document, "event-kinds", "span", "issue")
        pretty = self.run_checker(document, "event-kinds", "span", raw=json.dumps(document, indent=2))

        self.assertEqual(compact.returncode, 0, compact.stderr)
        self.assertEqual(pretty.returncode, 0, pretty.stderr)

    def test_event_kinds_fail_closed_without_echoing_document_content(self) -> None:
        cases: tuple[tuple[object, str | None], ...] = (
            (None, "not-json-sensitive-marker"),
            (None, '{"events":[{"type":"span"}],"value":NaN}'),
            ({}, None),
            ({"events": "span"}, None),
            ({"events": [{"type": 1}]}, None),
            ({"events": [{"type": "issue"}]}, None),
        )

        for document, raw in cases:
            with self.subTest(document=document, raw=raw):
                result = self.run_checker(document, "event-kinds", "span", raw=raw)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("sensitive-marker", result.stderr)

    def test_fields_require_exact_values_and_types(self) -> None:
        result = self.run_checker(
            {"ok": True, "status": 200, "path": "/health"},
            "fields",
            "ok=true",
            "status=200",
            'path="/health"',
        )

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_fields_fail_closed_for_missing_wrong_value_and_bool_integer_confusion(self) -> None:
        cases: tuple[tuple[dict[str, object], str], ...] = (
            ({"status": 200}, "ok=true"),
            ({"ok": False}, "ok=true"),
            ({"ok": 1}, "ok=true"),
            ({"status": True}, "status=1"),
        )

        for document, expectation in cases:
            with self.subTest(document=document, expectation=expectation):
                result = self.run_checker(document, "fields", expectation)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
