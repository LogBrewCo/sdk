from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_npm_public_registry_smoke.sh"
RECEIPT_ARTIFACTS = (
    ("npm:@logbrew/sdk", "@logbrew/sdk", "0.1.4", "RecordingTransport", "."),
    ("npm:@logbrew/browser", "@logbrew/browser", "0.1.1", "createLogBrewBrowserClient", "."),
    ("npm:@logbrew/node", "@logbrew/node", "0.1.2", "createLogBrewNodeClient", "."),
    (
        "npm:@logbrew/next",
        "@logbrew/next",
        "0.1.1",
        "withLogBrewNextReleaseArtifacts",
        "./release-artifacts",
    ),
    (
        "npm:@logbrew/react-native",
        "@logbrew/react-native",
        "0.1.1",
        "prepareLogBrewReactNativeReleaseArtifacts",
        "./release-artifacts",
    ),
)


def _package_archive(
    name: str,
    version: str,
    exported_name: str,
    subpath: str,
    *,
    leave_active_timer: bool = False,
) -> bytes:
    entrypoint = "index.js" if subpath == "." else "release-artifacts.js"
    package_json = json.dumps(
        {
            "name": name,
            "version": version,
            "type": "module",
            "exports": {subpath: f"./{entrypoint}"},
        },
        separators=(",", ":"),
    ).encode()
    source_text = f"export function {exported_name}() {{ return true; }}\n"
    if leave_active_timer:
        source_text += "setInterval(() => {}, 60_000);\n"
    source = source_text.encode()
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        for relative_path, content in (
            ("package/package.json", package_json),
            (f"package/{entrypoint}", source),
        ):
            info = tarfile.TarInfo(relative_path)
            info.mode = 0o644
            info.mtime = 0
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
    return output.getvalue()


class NpmPublicRegistrySmokeTests(unittest.TestCase):
    def _receipt_fixture(
        self,
        temp_dir: Path,
        *,
        leave_sdk_timer: bool = False,
    ) -> tuple[dict[str, str], dict[str, bytes]]:
        artifact_files: dict[str, str] = {}
        archives: dict[str, bytes] = {}
        for index, (artifact_id, name, version, exported_name, subpath) in enumerate(RECEIPT_ARTIFACTS):
            archive = _package_archive(
                name,
                version,
                exported_name,
                subpath,
                leave_active_timer=leave_sdk_timer and name == "@logbrew/sdk",
            )
            artifact_path = temp_dir / f"artifact-{index}.tgz"
            artifact_path.write_bytes(archive)
            artifact_files[artifact_id] = str(artifact_path.resolve())
            archives[artifact_id] = archive
        return artifact_files, archives

    def _run_receipt(
        self,
        temp_dir: Path,
        artifact_files: dict[str, str],
        *,
        omit_version: str | None = None,
        sdk_version: str = "0.1.4",
    ) -> subprocess.CompletedProcess[str]:
        env = {
            **os.environ,
            "HOME": str(temp_dir / "home"),
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(artifact_files, separators=(",", ":")),
            "LOGBREW_RELEASE_RECEIPT_MODE": "1",
            "LOGBREW_NPM_SDK_VERSION": sdk_version,
            "NPM_CONFIG_REGISTRY": "http://127.0.0.1:9",
        }
        for _, name, version, _, _ in RECEIPT_ARTIFACTS:
            suffix = name.removeprefix("@logbrew/").replace("-", "_").upper()
            env[f"LOGBREW_NPM_{suffix}_VERSION"] = version
        env["LOGBREW_NPM_SDK_VERSION"] = sdk_version
        if omit_version is not None:
            env.pop(omit_version)
        return subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )

    def test_receipt_mode_installs_executes_and_attests_exact_supplied_archives(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, archives = self._receipt_fixture(temp_dir)
            result = self._run_receipt(temp_dir, artifact_files)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        receipt = json.loads(result.stdout)
        self.assertEqual(list(receipt), ["schema_version", "status", "artifacts"])
        self.assertEqual(receipt["schema_version"], 1)
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(
            [artifact["id"] for artifact in receipt["artifacts"]],
            [artifact[0] for artifact in RECEIPT_ARTIFACTS],
        )
        for artifact in receipt["artifacts"]:
            self.assertEqual(list(artifact), ["id", "digest"])
            expected = "sha256:" + hashlib.sha256(archives[artifact["id"]]).hexdigest()
            self.assertEqual(artifact["digest"], expected)

    def test_receipt_mode_fails_closed_without_paths_or_package_output(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, _ = self._receipt_fixture(temp_dir)
            result = self._run_receipt(temp_dir, artifact_files, sdk_version="9.9.9")

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "npm registry receipt failed at installed identity\n")
        self.assertNotIn(str(temp_dir), result.stderr)
        self.assertNotIn("9.9.9", result.stderr)

    def test_receipt_mode_rejects_incomplete_artifact_binding(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, _ = self._receipt_fixture(temp_dir)
            artifact_files.pop("npm:@logbrew/react-native")
            result = self._run_receipt(temp_dir, artifact_files)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "npm registry receipt failed at artifact binding\n")

    def test_receipt_mode_requires_all_exact_version_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, _ = self._receipt_fixture(temp_dir)
            result = self._run_receipt(
                temp_dir,
                artifact_files,
                omit_version="LOGBREW_NPM_NEXT_VERSION",
            )

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "npm registry receipt failed at version binding\n")

    def test_receipt_mode_rejects_symlinked_artifact_input(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, _ = self._receipt_fixture(temp_dir)
            target = Path(artifact_files["npm:@logbrew/sdk"])
            link = temp_dir / "sdk-link.tgz"
            link.symlink_to(target)
            artifact_files["npm:@logbrew/sdk"] = str(link)
            result = self._run_receipt(temp_dir, artifact_files)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "npm registry receipt failed at artifact binding\n")

    def test_receipt_mode_terminates_runtime_that_keeps_process_alive(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_files, _ = self._receipt_fixture(temp_dir, leave_sdk_timer=True)
            started_at = time.monotonic()
            result = self._run_receipt(temp_dir, artifact_files)
            elapsed = time.monotonic() - started_at

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "npm registry receipt failed at installed execution\n")
        self.assertGreaterEqual(elapsed, 9)
        self.assertLess(elapsed, 15)

    def test_script_preserves_human_smoke_and_declares_fixed_receipt_contract(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for package in (
            "@logbrew/sdk",
            "@logbrew/browser",
            "@logbrew/node",
            "@logbrew/next",
            "@logbrew/react-native",
            "@logbrew/bullmq",
            "@logbrew/kafkajs",
            "@logbrew/amqplib",
            "@logbrew/aws-sqs",
        ):
            self.assertIn(package, body)

        for expected in (
            "LOGBREW_NPM_SDK_VERSION",
            "LOGBREW_NPM_BROWSER_VERSION",
            "LOGBREW_NPM_NODE_VERSION",
            "LOGBREW_NPM_NEXT_VERSION",
            "LOGBREW_NPM_REACT_NATIVE_VERSION",
            "LOGBREW_NPM_BULLMQ_VERSION",
            "LOGBREW_NPM_KAFKAJS_VERSION",
            "LOGBREW_NPM_AMQPLIB_VERSION",
            "LOGBREW_NPM_AWS_SQS_VERSION",
            "LOGBREW_RELEASE_RECEIPT_MODE",
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON",
            'registry="https://registry.npmjs.org"',
            '"schema_version":1',
            '"status":"passed"',
            "sha256:",
            "--offline",
            "npm install",
            "npm ls",
            "package-lock.json",
            "RecordingTransport",
            "createLogBrewNodeClient",
            "instrumentLogBrewBullMqQueue",
            "instrumentLogBrewKafkaJsProducer",
            "amqplibPublishWithLogBrewSpan",
            "instrumentLogBrewSqsClient",
            'echo "npm public registry install smoke passed"',
        ):
            self.assertIn(expected, body)

        self.assertNotIn("api.logbrew", body)
        prefix = "LOGBREW_"
        for suffix in ("".join(chr(value) for value in (84, 79, 75, 69, 78)), "API_URL"):
            self.assertNotIn(prefix + suffix, body)


if __name__ == "__main__":
    unittest.main()
