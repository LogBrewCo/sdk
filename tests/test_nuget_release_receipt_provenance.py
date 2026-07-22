from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_nuget_release_receipt_provenance.py"


def content_hash(body: bytes) -> str:
    return base64.b64encode(hashlib.sha512(body).digest()).decode("ascii")


class NugetReleaseReceiptProvenanceTests(unittest.TestCase):
    def fixture(self, root: Path, *, wrong_core: bool = False) -> list[str]:
        bound = root / "bound"
        source = root / "source"
        packages = root / "packages"
        bound.mkdir()
        source.mkdir()
        self.assertNotEqual(bound.resolve(), source.resolve())
        core = b"bound-core"
        client = b"bound-client"
        (bound / "0.nupkg").write_bytes(core)
        (bound / "1.nupkg").write_bytes(client)
        (source / "LogBrew.0.1.5.nupkg").hardlink_to(bound / "0.nupkg")
        (source / "LogBrew.HttpClient.0.1.0.nupkg").hardlink_to(bound / "1.nupkg")
        hashes = {
            "logbrew/0.1.5": content_hash(b"other-core" if wrong_core else core),
            "logbrew.httpclient/0.1.0": content_hash(client),
        }
        for identity, digest in hashes.items():
            package_id, version = identity.split("/")
            directory = packages / package_id / version
            directory.mkdir(parents=True)
            (directory / f"{package_id}.{version}.nupkg.sha512").write_text(
                digest,
                encoding="utf-8",
            )
            (directory / ".nupkg.metadata").write_text(
                json.dumps({"version": 2, "contentHash": digest, "source": str(source.resolve())}),
                encoding="utf-8",
            )
        assets = root / "project.assets.json"
        assets.write_text(
            json.dumps(
                {
                    "libraries": {
                        "LogBrew/0.1.5": {"type": "package", "sha512": hashes["logbrew/0.1.5"]},
                        "LogBrew.HttpClient/0.1.0": {
                            "type": "package",
                            "sha512": hashes["logbrew.httpclient/0.1.0"],
                        },
                    }
                }
            ),
            encoding="utf-8",
        )
        return [
            "python3",
            str(SCRIPT),
            "--bound-dir",
            str(bound),
            "--source-dir",
            str(source),
            "--packages-dir",
            str(packages),
            "--assets",
            str(assets),
            "--core-version",
            "0.1.5",
            "--httpclient-version",
            "0.1.0",
        ]

    def test_accepts_only_both_exact_bound_package_hashes_from_local_source(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            command = self.fixture(Path(raw_tmp))
            result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")

    def test_rejects_same_version_installed_from_different_core_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            command = self.fixture(Path(raw_tmp), wrong_core=True)
            result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "NuGet receipt provenance verification failed\n")


if __name__ == "__main__":
    unittest.main()
