import itertools
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "npm_settled_versions.py"
INSTALL_COMMAND = re.compile(r"^\s*(?:\w+=\S+\s+)*(?:npm (?:install|i)|pnpm add|bun add)\b")
VIEW_COMMAND = re.compile(r"\bnpm (?:view|show|info)\s+(.*)$", re.MULTILINE)
FAKE_NPM = """#!{python}
import json
import os
import sys

documents = json.loads(open(os.environ["FAKE_NPM_DOCUMENTS"], encoding="utf-8").read())
package = sys.argv[2]
if sys.argv[1] != "view" or package not in documents:
    sys.stderr.write("npm error code E404\\n")
    sys.exit(1)
document = documents[package]
sys.stdout.write(document if isinstance(document, str) else json.dumps(document))
"""


def published(age: timedelta) -> str:
    return (datetime.now(timezone.utc) - age).isoformat().replace("+00:00", "Z")


def document(latest: str, ages: dict[str, timedelta]) -> dict[str, object]:
    return {
        "time": {"created": published(timedelta(days=400)), **{v: published(age) for v, age in ages.items()}},
        "versions": list(ages),
        "dist-tags": {"latest": latest},
    }


def resolve(packages: list[str], documents: dict[str, object]) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as temp:
        bin_dir = Path(temp) / "bin"
        bin_dir.mkdir()
        npm = bin_dir / "npm"
        npm.write_text(FAKE_NPM.format(python=sys.executable), encoding="utf-8")
        npm.chmod(0o755)
        documents_path = Path(temp) / "documents.json"
        documents_path.write_text(json.dumps(documents), encoding="utf-8")
        env = {
            **os.environ,
            "FAKE_NPM_DOCUMENTS": str(documents_path),
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
        }
        return subprocess.run(
            [sys.executable, str(HELPER), *packages],
            capture_output=True,
            text=True,
            env=env,
            timeout=60,
            check=False,
        )


def install_commands(script: str) -> list[str]:
    commands = []
    lines = script.splitlines()
    for index, line in enumerate(lines):
        if not INSTALL_COMMAND.match(line):
            continue
        command = line
        while command.endswith("\\") and index + 1 < len(lines):
            index += 1
            command = command[:-1] + " " + lines[index]
        commands.append(command)
    return commands


def has_fixed_spec(argument: str) -> bool:
    name, separator, spec = argument[1:].partition("@")
    return bool(name and separator and re.match(r"[0-9^~<>=$]", spec))


class NpmSettledVersionsTests(unittest.TestCase):
    def test_picks_the_previous_release_while_the_newest_is_1_minute_old(self) -> None:
        result = resolve(
            ["vue"],
            {
                "vue": document(
                    "3.5.46",
                    {
                        "3.5.44": timedelta(days=30),
                        "3.5.45": timedelta(days=2),
                        "3.5.46": timedelta(minutes=1),
                    },
                )
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "3.5.45\n")

    def test_skips_prereleases_and_versions_above_latest(self) -> None:
        result = resolve(
            ["next", "rxjs"],
            {
                "next": document(
                    "16.2.10",
                    {
                        "16.2.9": timedelta(days=9),
                        "16.2.10-canary.3": timedelta(hours=2),
                        "16.2.10": timedelta(minutes=30),
                    },
                ),
                "rxjs": document(
                    "7.8.2",
                    {"7.8.1": timedelta(days=90), "7.8.2": timedelta(days=60), "8.0.0": timedelta(hours=2)},
                ),
            },
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "16.2.9 7.8.2\n")

    def test_fails_closed_when_the_registry_gives_no_settled_release(self) -> None:
        settled = document("1.0.0", {"1.0.0": timedelta(days=5)})
        for case, documents in (
            ("registry unreadable", {"vue": settled}),
            ("invalid JSON", {"vue": settled, "pkg": "{not json"}),
            ("no release times", {"vue": settled, "pkg": {"versions": ["1.0.0"], "dist-tags": {"latest": "1.0.0"}}}),
            ("only fresh releases", {"vue": settled, "pkg": document("1.0.0", {"1.0.0": timedelta(minutes=1)})}),
        ):
            with self.subTest(case):
                result = resolve(["vue", "pkg"], documents)

                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("cannot resolve a settled pkg release from the npm registry", result.stderr)

    def test_smoke_scripts_resolve_newest_npm_versions_only_through_the_helper(self) -> None:
        findings = []
        for path in sorted((ROOT / "scripts").glob("*.sh")):
            script = path.read_text(encoding="utf-8")
            for command in install_commands(script):
                arguments = shlex.split(INSTALL_COMMAND.sub("", command))
                for argument in itertools.takewhile(lambda token: token not in {"|", "||", "&&", ";"}, arguments):
                    if argument.startswith(("-", "$", "/", ".", ">", "2>")) or has_fixed_spec(argument):
                        continue
                    findings.append(f"{path.name}: install without a fixed version: {argument}")
            for match in VIEW_COMMAND.finditer(script):
                spec, *fields = shlex.split(match.group(1).split(")", 1)[0].rstrip("\\ "))
                if not has_fixed_spec(spec) and {"version", "dist-tags"} & set(fields):
                    findings.append(f"{path.name}: npm view resolves the newest {spec} version")

        self.assertEqual(findings, [])


if __name__ == "__main__":
    unittest.main()
