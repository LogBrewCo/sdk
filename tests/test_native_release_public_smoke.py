from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import gzip
import io
import json
import os
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "real_user_native_release_public_smoke.sh"
ARTIFACT_ID = "native:LogBrewCo/sdk"
VERSION = "0.2.2"
GO_CACHE = subprocess.check_output(["go", "env", "GOCACHE"], text=True).strip()
SOURCE_PATHS = (
    "LICENSE",
    "README.md",
    "c/logbrew-c/Makefile",
    "c/logbrew-c/README.md",
    "c/logbrew-c/include/logbrew.h",
    "c/logbrew-c/src/logbrew.c",
    "c/logbrew-c/src/logbrew_json.c",
    "c/logbrew-c/src/logbrew_context.c",
    "c/logbrew-c/src/logbrew_evidence.c",
    "c/logbrew-c/src/logbrew_internal.h",
    "c/logbrew-c/src/logbrew_metric.c",
    "c/logbrew-c/src/logbrew_recording_transport.c",
    "c/logbrew-c/src/logbrew_timeline.c",
    "c/logbrew-c/src/logbrew_trace.c",
)


def _add_bytes(archive: tarfile.TarFile, name: str, content: bytes) -> None:
    info = tarfile.TarInfo(name)
    info.mode = 0o644
    info.mtime = 0
    info.size = len(content)
    archive.addfile(info, io.BytesIO(content))


def _source_archive(
    path: Path,
    *,
    version: str = VERSION,
    mutations: dict[str, bytes] | None = None,
) -> bytes:
    root = f"sdk-{version}"
    replacements = mutations or {}
    with tarfile.open(path, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        root_info = tarfile.TarInfo(root)
        root_info.type = tarfile.DIRTYPE
        root_info.mode = 0o755
        root_info.mtime = 0
        archive.addfile(root_info)
        for relative_path in SOURCE_PATHS:
            content = replacements.get(relative_path, (ROOT / relative_path).read_bytes())
            _add_bytes(archive, f"{root}/{relative_path}", content)
    return path.read_bytes()


def _unsafe_archive(path: Path, kind: str, marker: str) -> None:
    if kind == "declared_size":
        info = tarfile.TarInfo(f"sdk-{VERSION}/{marker}")
        info.mode = 0o644
        info.mtime = 0
        info.size = 1024 * 1024 * 1024
        with gzip.open(path, "wb") as archive_stream:
            archive_stream.write(info.tobuf(format=tarfile.USTAR_FORMAT))
            archive_stream.write(b"\x00" * 1024)
        return

    with tarfile.open(path, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        _add_bytes(archive, f"sdk-{VERSION}/README.md", b"fixture")
        if kind == "traversal":
            _add_bytes(archive, f"sdk-{VERSION}/../../{marker}", b"unsafe")
        elif kind == "duplicate":
            _add_bytes(archive, f"sdk-{VERSION}/README.md", b"duplicate")
        elif kind in {"symlink", "hardlink", "fifo"}:
            info = tarfile.TarInfo(f"sdk-{VERSION}/{marker}")
            info.mtime = 0
            if kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = f"../../{marker}"
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = f"sdk-{VERSION}/README.md"
            else:
                info.type = tarfile.FIFOTYPE
            archive.addfile(info)
        elif kind == "oversize":
            content = b"x" * (16 * 1024 * 1024 + 1)
            _add_bytes(archive, f"sdk-{VERSION}/{marker}", content)
        elif kind == "entries":
            for index in range(4097):
                _add_bytes(archive, f"sdk-{VERSION}/entry-{index}", b"")
        elif kind == "pax_size":
            info = tarfile.TarInfo(f"sdk-{VERSION}/{marker}")
            info.mode = 0o644
            info.mtime = 0
            info.size = 0
            info.pax_headers = {"size": str(1024 * 1024 * 1024)}
            archive.addfile(info, io.BytesIO())
        elif kind == "missing":
            pass
        else:
            raise AssertionError(f"unsupported unsafe archive kind: {kind}")


class NativeReleasePublicSmokeTests(unittest.TestCase):
    def _run_receipt(
        self,
        temp_dir: Path,
        artifact_path: Path,
        *,
        version: str = VERSION,
        artifact_files: dict[str, str] | None = None,
        env_overrides: dict[str, str] | None = None,
        script_path: Path = SCRIPT,
    ) -> subprocess.CompletedProcess[str]:
        supplied = artifact_files if artifact_files is not None else {
            ARTIFACT_ID: str(artifact_path.absolute())
        }
        env = {
            **os.environ,
            "GOCACHE": GO_CACHE,
            "HOME": str(temp_dir / "home"),
            "LOGBREW_SDK_ROOT": str(ROOT),
            "LOGBREW_RELEASE_RECEIPT_MODE": "1",
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(supplied, separators=(",", ":")),
        }
        env.update(env_overrides or {})
        return subprocess.run(
            ["bash", str(script_path), version],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def _script_replacing(self, temp_dir: Path, name: str, old: str, new: str) -> Path:
        path = temp_dir / name
        body = SCRIPT.read_text(encoding="utf-8")
        replaced = body.replace(old, new, 1)
        self.assertNotEqual(replaced, body)
        path.write_text(replaced, encoding="utf-8")
        return path

    def _assert_failure(self, result: subprocess.CompletedProcess[str], stage: str) -> None:
        self.assertEqual(result.returncode, 1)
        self.assertEqual((result.stdout, result.stderr), ("", f"native release receipt failed at {stage}\n"))

    def test_receipt_mode_builds_executes_and_attests_exact_source_archive(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            archive_bytes = _source_archive(artifact_path)
            compiler = shutil.which("cc")
            self.assertIsNotNone(compiler)
            fake_bin = temp_dir / "bin"
            fake_bin.mkdir()
            compiler_args = temp_dir / "compiler-args.txt"
            fake_cc = fake_bin / "cc"
            fake_cc.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' compiler-invocation \"$@\" >> {shlex.quote(str(compiler_args))}\n"
                f"exec {shlex.quote(str(compiler))} \"$@\"\n",
                encoding="utf-8",
            )
            fake_cc.chmod(0o700)
            result = self._run_receipt(
                temp_dir, artifact_path,
                env_overrides={"PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"},
            )
            arguments = compiler_args.read_text(encoding="utf-8").splitlines()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(arguments.count("compiler-invocation"), 2)
        self.assertEqual(arguments.count("-c"), 1)
        for flag in ("-std=c99", "-Wall", "-Wextra", "-Wpedantic", "-Werror"):
            self.assertEqual(arguments.count(flag), 2)
        for source in SOURCE_PATHS:
            if source.endswith(".c"):
                self.assertEqual(sum(arg.endswith("/" + source) for arg in arguments), 1)
        self.assertEqual(result.stderr, "")
        attestation = json.loads(result.stdout)
        self.assertEqual(list(attestation), ["schema_version", "status", "artifacts"])
        self.assertEqual(attestation["schema_version"], 1)
        self.assertEqual(attestation["status"], "passed")
        self.assertEqual(len(attestation["artifacts"]), 1)
        artifact = attestation["artifacts"][0]
        self.assertEqual(list(artifact), ["id", "digest"])
        self.assertEqual(artifact["id"], ARTIFACT_ID)
        self.assertEqual(artifact["digest"], "sha256:" + hashlib.sha256(archive_bytes).hexdigest())

    def test_human_mode_uses_bounded_github_tag_archive_and_fixed_output(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            public_header = (ROOT / "c/logbrew-c/include/logbrew.h").read_bytes()
            _source_archive(
                artifact_path,
                version=VERSION,
                mutations={"c/logbrew-c/include/logbrew.h": public_header},
            )
            fake_bin = temp_dir / "bin"
            fake_bin.mkdir()
            curl_args = temp_dir / "curl-args.txt"
            fake_curl = fake_bin / "curl"
            fake_curl.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_CURL_ARGS"
destination=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output" ]]; then
    destination="$2"
    shift 2
  else
    shift
  fi
done
test -n "$destination"
cp "$FAKE_SOURCE_ARCHIVE" "$destination"
""",
                encoding="utf-8",
            )
            fake_curl.chmod(fake_curl.stat().st_mode | stat.S_IXUSR)
            env = {
                **os.environ,
                "GOCACHE": GO_CACHE,
                "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
                "FAKE_CURL_ARGS": str(curl_args),
                "FAKE_SOURCE_ARCHIVE": str(artifact_path),
            }
            env.pop("LOGBREW_RELEASE_RECEIPT_MODE", None)
            env.pop("LOGBREW_RELEASE_ARTIFACT_FILES_JSON", None)
            script_path = self._script_replacing(
                temp_dir,
                "download-contract-smoke.sh",
                'build_dir="$tmp_dir/build"',
                'echo "native GitHub release install smoke passed"\nexit 0\n\nbuild_dir="$tmp_dir/build"',
            )
            result = subprocess.run(
                ["bash", str(script_path)],
                cwd=ROOT,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )

            recorded_args = curl_args.read_text(encoding="utf-8")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "native GitHub release install smoke passed\n")
        self.assertEqual(result.stderr, "")
        self.assertIn("--max-time\n30\n", recorded_args)
        self.assertIn("--max-filesize\n67108864\n", recorded_args)
        self.assertIn(
            "https://github.com/LogBrewCo/sdk/archive/refs/tags/c/logbrew-c/v0.2.2.tar.gz",
            recorded_args,
        )

    def test_receipt_mode_rejects_incomplete_or_extra_artifact_binding(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            cases = (
                {},
                {"native:wrong": str(artifact_path.resolve())},
                {
                    ARTIFACT_ID: str(artifact_path.resolve()),
                    "native:extra": str(artifact_path.resolve()),
                },
            )
            results = [
                self._run_receipt(temp_dir, artifact_path, artifact_files=case)
                for case in cases
            ]

        for result in results:
            self._assert_failure(result, "artifact binding")

    def test_receipt_mode_rejects_symlinked_artifact_input(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            link = temp_dir / "source-link.tar.gz"
            link.symlink_to(artifact_path)
            result = self._run_receipt(temp_dir, link)

        self._assert_failure(result, "artifact binding")

    def test_receipt_mode_rejects_unsafe_archive_surfaces_without_echoing_them(self) -> None:
        marker = "ARCHIVE_CANARY_7A91"
        for kind in (
            "traversal",
            "duplicate",
            "symlink",
            "hardlink",
            "fifo",
            "oversize",
            "entries",
            "declared_size",
            "pax_size",
            "missing",
        ):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as raw_temp_dir:
                temp_dir = Path(raw_temp_dir)
                artifact_path = temp_dir / f"{kind}.tar.gz"
                _unsafe_archive(artifact_path, kind, marker)
                result = self._run_receipt(temp_dir, artifact_path)

            self._assert_failure(result, "archive validation")
            self.assertNotIn(marker, result.stderr)
            self.assertNotIn(str(temp_dir), result.stderr)

        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "malformed.tar.gz"
            artifact_path.write_bytes(b"not a source archive")
            result = self._run_receipt(temp_dir, artifact_path)

        self._assert_failure(result, "archive validation")

        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            expansion_path = temp_dir / "expansion.tar.gz"
            with gzip.open(expansion_path, "wb", compresslevel=1) as destination:
                destination.write(b"\x00" * (2 * 1024 * 1024))
            bounded_script = self._script_replacing(
                temp_dir,
                "bounded-decompression-smoke.sh",
                "MAX_DECOMPRESSED_TAR_BYTES = 144 * 1024 * 1024",
                "MAX_DECOMPRESSED_TAR_BYTES = 1024 * 1024",
            )
            expansion_result = self._run_receipt(
                temp_dir, expansion_path, script_path=bounded_script,
            )

        self._assert_failure(expansion_result, "archive validation")

    def test_receipt_mode_requires_exact_embedded_release_version(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            result = self._run_receipt(temp_dir, artifact_path, version="0.2.3")

        self._assert_failure(result, "release identity")
        self.assertNotIn("0.2.2", result.stderr)
        self.assertNotIn("0.2.3", result.stderr)

    def test_receipt_mode_rejects_untrusted_shared_probe_path(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            result = self._run_receipt(
                temp_dir,
                artifact_path,
                env_overrides={"LOGBREW_TOOLCHAIN_PROBE_BIN": "relative-probe"},
            )

        self._assert_failure(result, "toolchain")

    def test_receipt_mode_bounds_build_and_runtime_diagnostics(self) -> None:
        build_canary = b"COMPILER_CANARY_4C62"
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            fake_bin = temp_dir / "bin"
            fake_bin.mkdir()
            fake_cc = fake_bin / "cc"
            fake_cc.write_bytes(b"#!/bin/sh\nprintf '%s\\n' " + build_canary + b" >&2\nexit 1\n")
            fake_cc.chmod(0o700)

            runtime_bin = temp_dir / "runtime-bin"
            runtime_bin.mkdir()
            runtime_cc = runtime_bin / "cc"
            runtime_cc.write_text(
                """#!/usr/bin/env python3
from pathlib import Path
import sys
arguments = sys.argv[1:]
if "-o" in arguments:
    output = Path(arguments[arguments.index("-o") + 1])
    output.write_text('#!/bin/sh\\nprintf "RUNTIME_CANARY_9D03\\\\n" >&2\\nwhile :; do :; done\\n')
    output.chmod(0o700)
else:
    for source in (Path(value) for value in arguments if value.endswith(".c")):
        Path(source.stem + ".o").touch()
""",
                encoding="utf-8",
            )
            runtime_cc.chmod(0o700)
            bounded_script = self._script_replacing(
                temp_dir,
                "bounded-native-runtime-smoke.sh",
                "timeout=5000",
                "timeout=250",
            )
            started_at = time.monotonic()
            with ThreadPoolExecutor(max_workers=2) as executor:
                build_future = executor.submit(
                    self._run_receipt, temp_dir, artifact_path,
                    env_overrides={"PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"},
                )
                runtime_future = executor.submit(
                    self._run_receipt, temp_dir, artifact_path, script_path=bounded_script,
                    env_overrides={"PATH": f"{runtime_bin}{os.pathsep}{os.environ['PATH']}"},
                )
                build_result, runtime_result = build_future.result(), runtime_future.result()
            elapsed = time.monotonic() - started_at

        self._assert_failure(build_result, "native build")
        self.assertNotIn(build_canary.decode(), build_result.stderr)
        self._assert_failure(runtime_result, "installed execution")
        self.assertNotIn("RUNTIME_CANARY_9D03", runtime_result.stderr)
        self.assertGreaterEqual(elapsed, 0.2)
        self.assertLess(elapsed, 10)

    def test_script_declares_fixed_native_release_contract(self) -> None:
        body = SCRIPT.read_text(encoding="utf-8")

        for expected in (
            ARTIFACT_ID,
            "LOGBREW_RELEASE_RECEIPT_MODE",
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON",
            "LOGBREW_C_VERSION",
            "logbrew_recording_transport_as_transport",
            "https://github.com/LogBrewCo/sdk/archive/refs/tags/",
            '"schema_version"',
            '"status"',
            "sha256:",
            "O_NOFOLLOW",
            "MAX_ARCHIVE_BYTES",
            "MAX_EXTRACTED_BYTES",
            "MAX_ARCHIVE_ENTRIES",
            "MAX_DECOMPRESSED_TAR_BYTES",
            "MAX_TAR_METADATA_BYTES",
            "gzip.open",
            "prevalidate_tar",
            "run_bounded_command",
            '"$toolchain_probe_bin" deadline',
            "native GitHub release install smoke passed",
        ):
            self.assertIn(expected, body)

        self.assertLess(body.index("gzip.open"), body.index("tarfile.open"))
        self.assertNotIn("if ! cc \\", body)
        self.assertNotIn("if ! ar rcs", body)

        self.assertNotIn("api.logbrew", body)
        self.assertNotIn("Authorization", body)


if __name__ == "__main__":
    unittest.main()
