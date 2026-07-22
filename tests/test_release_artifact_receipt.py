from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from io import BytesIO


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "release_artifact_receipt.py"


class ReleaseArtifactReceiptTests(unittest.TestCase):
    def run_helper(
        self,
        *arguments: str,
        artifacts: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        environment = os.environ.copy()
        if artifacts is not None:
            environment["LOGBREW_RELEASE_ARTIFACT_FILES_JSON"] = json.dumps(
                artifacts,
                separators=(",", ":"),
            )
        return subprocess.run(
            ["python3", str(SCRIPT), *arguments],
            cwd=ROOT,
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

    def test_bind_and_attest_preserve_canonical_ids_and_exact_digests(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            core = tmp / "core.nupkg"
            client = tmp / "client.nupkg"
            core.write_bytes(b"core-package")
            client.write_bytes(b"client-package")
            artifacts = {
                "nuget:LogBrew": str(core.resolve()),
                "nuget:LogBrew.HttpClient": str(client.resolve()),
            }
            bound = tmp / "bound"
            metadata = tmp / "metadata.json"

            result = self.run_helper(
                "bind",
                "--family",
                "nuget",
                "--output-dir",
                str(bound),
                "--metadata",
                str(metadata),
                artifacts=artifacts,
            )
            attestation = self.run_helper(
                "attest",
                "--family",
                "nuget",
                "--metadata",
                str(metadata),
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertEqual(attestation.returncode, 0, attestation.stderr)
        payload = json.loads(attestation.stdout)
        self.assertEqual(list(payload), ["schema_version", "status", "artifacts"])
        self.assertEqual(
            payload,
            {
                "schema_version": 1,
                "status": "passed",
                "artifacts": [
                    {
                        "id": "nuget:LogBrew",
                        "digest": "sha256:" + hashlib.sha256(b"core-package").hexdigest(),
                    },
                    {
                        "id": "nuget:LogBrew.HttpClient",
                        "digest": "sha256:" + hashlib.sha256(b"client-package").hexdigest(),
                    },
                ],
            },
        )

    def test_bind_rejects_missing_extra_relative_and_symlink_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            artifact = tmp / "artifact.crate"
            artifact.write_bytes(b"crate")
            link = tmp / "link.crate"
            link.symlink_to(artifact)
            cases = (
                {},
                {"crates:logbrew": str(artifact.resolve()), "extra": str(artifact.resolve())},
                {"crates:logbrew": "artifact.crate"},
                {"crates:logbrew": str(link.absolute())},
            )
            for index, supplied in enumerate(cases):
                with self.subTest(supplied=supplied):
                    result = self.run_helper(
                        "bind",
                        "--family",
                        "crates",
                        "--output-dir",
                        str(tmp / f"bound-{index}"),
                        "--metadata",
                        str(tmp / f"metadata-{index}.json"),
                        artifacts=supplied,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr, "release artifact binding failed\n")
                    self.assertNotIn(str(tmp), result.stderr)

    def test_family_ids_match_the_installed_receipt_contract(self) -> None:
        expected = {
            "crates": ["crates:logbrew"],
            "go": ["go:github.com/LogBrewCo/sdk/go/logbrew"],
            "maven": ["maven:co.logbrew:logbrew-sdk"],
            "nuget": ["nuget:LogBrew", "nuget:LogBrew.HttpClient"],
            "packagist": ["packagist:logbrew/sdk"],
            "pypi": [
                "pypi:logbrew-sdk",
                "pypi:logbrew-fastapi",
                "pypi:logbrew-flask",
                "pypi:logbrew-django",
            ],
            "rubygems": ["rubygems:logbrew-sdk"],
            "swiftpm": ["swiftpm:LogBrewCo/sdk"],
        }
        for family, artifact_ids in expected.items():
            with self.subTest(family=family):
                result = self.run_helper("ids", "--family", family)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.splitlines(), artifact_ids)

    def test_extract_rejects_archive_traversal_without_writing_outside(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            archive = tmp / "unsafe.crate"
            with tarfile.open(archive, "w:gz") as bundle:
                content = b"unsafe"
                member = tarfile.TarInfo("../escape")
                member.size = len(content)
                bundle.addfile(member, BytesIO(content))
            bound = tmp / "bound"
            metadata = tmp / "metadata.json"
            bind = self.run_helper(
                "bind",
                "--family",
                "crates",
                "--output-dir",
                str(bound),
                "--metadata",
                str(metadata),
                artifacts={"crates:logbrew": str(archive.resolve())},
            )
            self.assertEqual(bind.returncode, 0, bind.stderr)

            result = self.run_helper(
                "extract",
                "--family",
                "crates",
                "--metadata",
                str(metadata),
                "--index",
                "0",
                "--output-dir",
                str(tmp / "extracted"),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "release artifact binding failed\n")
            self.assertFalse((tmp.parent / "escape").exists())


if __name__ == "__main__":
    unittest.main()
