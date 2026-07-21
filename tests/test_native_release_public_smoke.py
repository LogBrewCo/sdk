from __future__ import annotations

import hashlib
import gzip
import io
import json
import os
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
VERSION = "0.1.0"
SOURCE_PATHS = (
    "LICENSE",
    "README.md",
    "c/logbrew-c/Makefile",
    "c/logbrew-c/README.md",
    "c/logbrew-c/include/logbrew.h",
    "c/logbrew-c/src/logbrew.c",
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
        info = tarfile.TarInfo(f"sdk-0.1.0/{marker}")
        info.mode = 0o644
        info.mtime = 0
        info.size = 1024 * 1024 * 1024
        with gzip.open(path, "wb") as archive_stream:
            archive_stream.write(info.tobuf(format=tarfile.USTAR_FORMAT))
            archive_stream.write(b"\x00" * 1024)
        return

    with tarfile.open(path, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
        _add_bytes(archive, "sdk-0.1.0/README.md", b"fixture")
        if kind == "traversal":
            _add_bytes(archive, f"sdk-0.1.0/../../{marker}", b"unsafe")
        elif kind == "duplicate":
            _add_bytes(archive, "sdk-0.1.0/README.md", b"duplicate")
        elif kind in {"symlink", "hardlink", "fifo"}:
            info = tarfile.TarInfo(f"sdk-0.1.0/{marker}")
            info.mtime = 0
            if kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = f"../../{marker}"
            elif kind == "hardlink":
                info.type = tarfile.LNKTYPE
                info.linkname = "sdk-0.1.0/README.md"
            else:
                info.type = tarfile.FIFOTYPE
            archive.addfile(info)
        elif kind == "oversize":
            content = b"x" * (16 * 1024 * 1024 + 1)
            _add_bytes(archive, f"sdk-0.1.0/{marker}", content)
        elif kind == "entries":
            for index in range(4097):
                _add_bytes(archive, f"sdk-0.1.0/entry-{index}", b"")
        elif kind == "pax_size":
            info = tarfile.TarInfo(f"sdk-0.1.0/{marker}")
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
    ) -> subprocess.CompletedProcess[str]:
        supplied = (
            artifact_files
            if artifact_files is not None
            else {ARTIFACT_ID: str(artifact_path.absolute())}
        )
        env = {
            **os.environ,
            "HOME": str(temp_dir / "home"),
            "LOGBREW_RELEASE_RECEIPT_MODE": "1",
            "LOGBREW_RELEASE_ARTIFACT_FILES_JSON": json.dumps(supplied, separators=(",", ":")),
        }
        env.update(env_overrides or {})
        return subprocess.run(
            ["bash", str(SCRIPT), version],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def test_receipt_mode_builds_executes_and_attests_exact_source_archive(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            archive_bytes = _source_archive(artifact_path)
            result = self._run_receipt(temp_dir, artifact_path)

        self.assertEqual(result.returncode, 0, result.stderr)
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
            _source_archive(artifact_path)
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
                "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
                "FAKE_CURL_ARGS": str(curl_args),
                "FAKE_SOURCE_ARCHIVE": str(artifact_path),
            }
            env.pop("LOGBREW_RELEASE_RECEIPT_MODE", None)
            env.pop("LOGBREW_RELEASE_ARTIFACT_FILES_JSON", None)
            result = subprocess.run(
                ["bash", str(SCRIPT), VERSION],
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
            "https://github.com/LogBrewCo/sdk/archive/refs/tags/v0.1.0.tar.gz",
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
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "native release receipt failed at artifact binding\n")

    def test_receipt_mode_rejects_symlinked_artifact_input(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            link = temp_dir / "source-link.tar.gz"
            link.symlink_to(artifact_path)
            result = self._run_receipt(temp_dir, link)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "native release receipt failed at artifact binding\n")

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

            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "native release receipt failed at archive validation\n")
            self.assertNotIn(marker, result.stderr)
            self.assertNotIn(str(temp_dir), result.stderr)

        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "malformed.tar.gz"
            artifact_path.write_bytes(b"not a source archive")
            result = self._run_receipt(temp_dir, artifact_path)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "native release receipt failed at archive validation\n")

        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            base_path = temp_dir / "base.tar.gz"
            expansion_path = temp_dir / "expansion.tar.gz"
            _source_archive(base_path)
            with gzip.open(base_path, "rb") as source, gzip.open(
                expansion_path,
                "wb",
                compresslevel=1,
            ) as destination:
                while chunk := source.read(1024 * 1024):
                    destination.write(chunk)
                zero_chunk = b"\x00" * (1024 * 1024)
                for _ in range(145):
                    destination.write(zero_chunk)
            expansion_result = self._run_receipt(temp_dir, expansion_path)

        self.assertEqual(expansion_result.returncode, 1)
        self.assertEqual(expansion_result.stdout, "")
        self.assertEqual(
            expansion_result.stderr,
            "native release receipt failed at archive validation\n",
        )

    def test_receipt_mode_requires_exact_embedded_release_version(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            result = self._run_receipt(temp_dir, artifact_path, version="0.1.2")

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "native release receipt failed at release identity\n")
        self.assertNotIn("0.1.0", result.stderr)
        self.assertNotIn("0.1.2", result.stderr)

    def test_receipt_mode_bounds_build_and_runtime_diagnostics(self) -> None:
        build_canary = b"COMPILER_CANARY_4C62"
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            broken_path = temp_dir / "broken.tar.gz"
            broken_source = (
                ROOT / "c/logbrew-c/src/logbrew.c"
            ).read_bytes() + build_canary
            _source_archive(
                broken_path,
                mutations={"c/logbrew-c/src/logbrew.c": broken_source},
            )
            build_result = self._run_receipt(temp_dir, broken_path)

            hanging_path = temp_dir / "hanging.tar.gz"
            source = (ROOT / "c/logbrew-c/src/logbrew.c").read_bytes()
            needle = b"void logbrew_recording_transport_init(\n"
            hanging_source = source.replace(
                needle,
                needle + b"    /* RUNTIME_CANARY_9D03 */\n",
                1,
            ).replace(
                b"    size_t step_count) {\n  if (transport == NULL)",
                b"    size_t step_count) {\n"
                b"  fputs(\"RUNTIME_CANARY_9D03\\n\", stderr);\n"
                b"  for (;;) { }\n"
                b"  if (transport == NULL)",
                1,
            )
            self.assertNotEqual(hanging_source, source)
            _source_archive(
                hanging_path,
                mutations={"c/logbrew-c/src/logbrew.c": hanging_source},
            )
            started_at = time.monotonic()
            runtime_result = self._run_receipt(temp_dir, hanging_path)
            elapsed = time.monotonic() - started_at

        self.assertEqual(build_result.returncode, 1)
        self.assertEqual(build_result.stdout, "")
        self.assertEqual(build_result.stderr, "native release receipt failed at native build\n")
        self.assertNotIn(build_canary.decode(), build_result.stderr)
        self.assertEqual(runtime_result.returncode, 1)
        self.assertEqual(runtime_result.stdout, "")
        self.assertEqual(runtime_result.stderr, "native release receipt failed at installed execution\n")
        self.assertNotIn("RUNTIME_CANARY_9D03", runtime_result.stderr)
        self.assertGreaterEqual(elapsed, 4)
        self.assertLess(elapsed, 12)

    def test_receipt_mode_times_out_and_reaps_a_hanging_compiler(self) -> None:
        with tempfile.TemporaryDirectory() as raw_temp_dir:
            temp_dir = Path(raw_temp_dir)
            artifact_path = temp_dir / "source.tar.gz"
            _source_archive(artifact_path)
            fake_bin = temp_dir / "bin"
            fake_bin.mkdir()
            compiler_pid = temp_dir / "compiler.pid"
            fake_cc = fake_bin / "cc"
            fake_cc.write_text(
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$$\" > {compiler_pid!s}\n"
                "exec sleep 60\n",
                encoding="utf-8",
            )
            fake_cc.chmod(fake_cc.stat().st_mode | stat.S_IXUSR)
            started_at = time.monotonic()
            result = self._run_receipt(
                temp_dir,
                artifact_path,
                env_overrides={"PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}"},
            )
            elapsed = time.monotonic() - started_at
            pid = int(compiler_pid.read_text(encoding="utf-8"))

            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "native release receipt failed at native build\n")
        self.assertGreaterEqual(elapsed, 10)
        self.assertLess(elapsed, 18)

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
            "BUILD_TIMEOUT_SECONDS",
        ):
            self.assertIn(expected, body)

        self.assertLess(body.index("gzip.open"), body.index("tarfile.open"))
        self.assertNotIn("if ! cc \\", body)
        self.assertNotIn("if ! ar rcs", body)

        self.assertNotIn("api.logbrew", body)
        self.assertNotIn("Authorization", body)


if __name__ == "__main__":
    unittest.main()
