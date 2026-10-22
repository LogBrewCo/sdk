from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "scoped_release_notes.py"
SPEC = importlib.util.spec_from_file_location("scoped_release_notes", SCRIPT)
assert SPEC is not None
scoped_release_notes = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(scoped_release_notes)


class ScopedReleaseNotesTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, self.previous)
        self.git("init", "-q")
        self.commit("go/pkg/a.go", "chore(go): start the package")
        self.git("tag", "go/pkg/v0.1.0")

    def git(self, *args: str) -> None:
        subprocess.run(
            ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", *args],
            check=True,
            capture_output=True,
        )

    def commit(self, path: str, subject: str) -> None:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(subject)
        self.git("add", path)
        self.git("commit", "-q", "-m", subject)

    def test_groups_user_visible_commits_of_one_package_since_the_previous_tag(self) -> None:
        self.commit("go/pkg/b.go", "feat(go): keep drop counts across restarts")
        self.commit("rust/other/c.rs", "feat(rust): unrelated package change")
        self.commit("go/pkg/d.go", "fix(go): retry a failed save")
        self.commit("go/pkg/e.go", "perf(go): encode counts once")
        self.commit("go/pkg/f.go", "test(go): cover the restart")

        notes = scoped_release_notes.release_notes("go/pkg", "go/pkg/v0.1.0", "HEAD")

        self.assertEqual(
            notes,
            "### Added\n- keep drop counts across restarts\n\n"
            "### Fixed\n- retry a failed save\n\n"
            "### Faster\n- encode counts once\n",
        )

    def test_a_package_without_user_visible_commits_gets_a_maintenance_note(self) -> None:
        self.commit("go/pkg/b.go", "chore(go): bump the toolchain")

        notes = scoped_release_notes.release_notes("go/pkg", "go/pkg/v0.1.0", "HEAD")

        self.assertEqual(notes, "Maintenance release with no behavior changes.\n")


if __name__ == "__main__":
    unittest.main()
