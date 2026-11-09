from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("capture_matrix", ROOT / "tools" / "capture-matrix" / "capture_matrix.py")
assert SPEC is not None and SPEC.loader is not None
capture_matrix = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = capture_matrix
SPEC.loader.exec_module(capture_matrix)


class HashedFilesTest(unittest.TestCase):
    def test_hashes_only_files_git_would_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            repository = Path(temporary)
            package = repository / "pkg"
            files = {
                ".gitignore": "*.egg-info/\n__pycache__/\n",
                "pkg/src/module.py": "tracked\n",
                "pkg/src/added.py": "untracked, not ignored\n",
                "pkg/src/pkg.egg-info/PKG-INFO": "ignored build output\n",
                "pkg/src/__pycache__/module.pyc": "ignored bytecode\n",
                "pkg/tests/test_module.py": "tests are not hashed\n",
                "pkg/README.md": "docs are not hashed\n",
            }
            for name, text in files.items():
                (repository / name).parent.mkdir(parents=True, exist_ok=True)
                (repository / name).write_text(text, encoding="utf-8")
            subprocess.run(["git", "init", "--quiet"], cwd=repository, check=True)
            subprocess.run(
                ["git", "add", ".gitignore", "pkg/src/module.py", "pkg/tests", "pkg/README.md"],
                cwd=repository,
                check=True,
            )

            hashed = [path.relative_to(package).as_posix() for path in capture_matrix._hashed_files(package)]

        self.assertEqual(hashed, ["src/added.py", "src/module.py"])


if __name__ == "__main__":
    unittest.main()
