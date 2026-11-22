from __future__ import annotations

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


# Each package file before a change, as the repository has it.
PACKAGE = {
    "pkg/go.mod": "module example.com/pkg\n\nrequire golang.org/x/text v0.43.0 // indirect\n",
    "pkg/go.sum": "golang.org/x/text v0.43.0 h1:1Qivrlhw=\n",
    "pkg/composer.json": '{"require-dev": {"guzzlehttp/guzzle": "^7.9"}}\n',
    "pkg/Cargo.toml": '[dependencies]\nopentelemetry = { version = "0.32", features = ["trace"] }\ntime = "=0.3.51"\n',
    "pkg/pyproject.toml": '[project.optional-dependencies]\nrq = ["rq>=2,<3"]\n',
    "pkg/Pkg.csproj": '<PackageReference Include="OpenTelemetry" Version="1.16.0" />\n',
    "pkg/pom.xml": "<dependency><artifactId>okhttp</artifactId><version>4.12.0</version></dependency>\n",
    "pkg/package.json": '{"devDependencies": {"@types/node": "26.6.5"}}\n',
    "pkg/bun.lock": '{"packages": {"@types/node": ["@types/node@26.6.5", "sha512-uMzsv9"]}}\n',
    "pkg/client.go": "package pkg\n\nconst level = 1\n",
    "probe/Probe.csproj": '<PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.9" />\n',
    "probe/main.go": "package main\n",
    "families/fam.sh": "install\n",
}

# Changes that Dependabot makes, taken from its pull requests: only versions change.
VERSION_ONLY = {
    "Go module": {
        "pkg/go.mod": "module example.com/pkg\n\nrequire golang.org/x/text v0.44.0 // indirect\n",
        "pkg/go.sum": "golang.org/x/text v0.44.0 h1:YItdp=\n",
    },
    "Composer range": {"pkg/composer.json": '{"require-dev": {"guzzlehttp/guzzle": "^7.9 || ^8.0"}}\n'},
    "Cargo": {
        "pkg/Cargo.toml": '[dependencies]\nopentelemetry = { version = "0.33", features = ["trace"] }\n'
        'time = "=0.3.55"\n'
    },
    "Python range": {"pkg/pyproject.toml": '[project.optional-dependencies]\nrq = ["rq>=2,<4"]\n'},
    "NuGet": {"pkg/Pkg.csproj": '<PackageReference Include="OpenTelemetry" Version="1.21.0" />\n'},
    "Maven": {"pkg/pom.xml": "<dependency><artifactId>okhttp</artifactId><version>5.5.1</version></dependency>\n"},
    "npm and Bun lockfile": {
        "pkg/package.json": '{"devDependencies": {"@types/node": "~26.6.6"}}\n',
        "pkg/bun.lock": '{"packages": {"@types/node": ["@types/node@26.6.6", "sha512-MzQj+8"]}}\n',
    },
    "probe NuGet": {
        "probe/Probe.csproj": '<PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.15" />\n'
    },
}

# Changes that can change what the package sends.
BEHAVIOR = {
    "package source": {"pkg/client.go": "package pkg\n\nconst level = 2\n"},
    "added dependency": {"pkg/package.json": '{"devDependencies": {"@types/node": "26.6.5", "left-pad": "1.3.0"}}\n'},
    "Cargo features": {
        "pkg/Cargo.toml": '[dependencies]\nopentelemetry = { version = "0.32", features = ["trace", "metrics"] }\n'
        'time = "=0.3.51"\n'
    },
    "replaced dependency": {"pkg/Pkg.csproj": '<PackageReference Include="OpenTelemetry.Api" Version="1.16.0" />\n'},
    "probe source": {"probe/main.go": "package main\n\nfunc main() {}\n"},
    "family setup": {"families/fam.sh": "install --with-extras\n"},
}


class InputHashTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.write(PACKAGE)
        (self.root / "tool.py").write_text("tool\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)
        for name, value in {
            "ROOT": self.root,
            "PROBES": self.root,
            "FAMILIES": self.root / "families",
            "__file__": str(self.root / "tool.py"),
        }.items():
            patcher = mock.patch.object(capture_matrix, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.probe = capture_matrix.Probe(
            package="probe", family="fam", run=(), inputs=("pkg",), not_applicable={}, parts=(), method="m"
        )

    def write(self, files: dict[str, str]) -> None:
        for name, text in files.items():
            (self.root / name).parent.mkdir(parents=True, exist_ok=True)
            (self.root / name).write_text(text, encoding="utf-8")

    def hash_after(self, change: dict[str, str]) -> str:
        self.write(change)
        try:
            return str(capture_matrix.input_hash(self.probe, {"probe": self.probe}))
        finally:
            self.write({name: PACKAGE[name] for name in change})

    def test_a_version_only_update_keeps_the_record_current(self) -> None:
        before = self.hash_after({})
        for name, change in VERSION_ONLY.items():
            with self.subTest(name):
                self.assertEqual(self.hash_after(change), before)

    def test_a_change_that_can_change_capture_makes_the_record_stale(self) -> None:
        before = self.hash_after({})
        for name, change in BEHAVIOR.items():
            with self.subTest(name):
                self.assertNotEqual(self.hash_after(change), before)


if __name__ == "__main__":
    unittest.main()
