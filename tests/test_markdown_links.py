import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "check_markdown_links.py"
SPEC = importlib.util.spec_from_file_location("check_markdown_links", MODULE_PATH)
assert SPEC is not None
check_markdown_links = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(check_markdown_links)


class MarkdownLinksTests(unittest.TestCase):
    def test_validates_local_files_directories_and_heading_anchors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs").mkdir()
            (root / "docs" / "guide.md").write_text("# Quick Start\n\n## Install SDK\n", encoding="utf-8")
            (root / "README.md").write_text(
                "[docs](docs)\n[guide](docs/guide.md)\n[install](docs/guide.md#install-sdk)\n",
                encoding="utf-8",
            )

            self.assertEqual(check_markdown_links.validate(root), [])

    def test_reports_missing_targets_and_anchors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "docs").mkdir()
            (root / "docs" / "guide.md").write_text("# Existing\n", encoding="utf-8")
            (root / "README.md").write_text(
                "[missing](docs/missing.md)\n[missing anchor](docs/guide.md#not-here)\n",
                encoding="utf-8",
            )

            failures = check_markdown_links.validate(root)

        self.assertEqual(len(failures), 2)
        self.assertIn("missing link target", failures[0])
        self.assertIn("missing heading anchor #not-here", failures[1])


if __name__ == "__main__":
    unittest.main()
