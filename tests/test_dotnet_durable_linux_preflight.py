import sys
import tempfile
import unittest
from pathlib import Path

from tests.test_dotnet_durable_delivery_workflow_gates import (
    APP_WITNESS_STAGES,
    CREATION_FAILURE_CASES,
    LINUX_PREFLIGHT_FAILURE_CASES,
    LINUX_PREFLIGHT_PASSED,
    ROOT,
    SMOKE,
    VERIFIER,
    load_verifier,
    write_test_witness,
)

PREFLIGHT_SOURCE = ROOT / "scripts" / "dotnet_durable_storage_preflight.cs"
UNIX_NATIVE_SOURCE = ROOT / "dotnet" / "logbrew-dotnet" / "src" / "LogBrew" / "DurableUnixNative.cs"


class DotnetDurableLinuxPreflightTests(unittest.TestCase):
    def test_linux_storage_preflight_is_fixed_ordered_and_terminal(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            request = root / "request"
            for marker, label in LINUX_PREFLIGHT_FAILURE_CASES:
                with self.subTest(marker=marker):
                    witness = root / marker
                    write_test_witness(witness, APP_WITNESS_STAGES[:1])
                    (witness / marker).write_bytes(verifier.WITNESS_VALUE)
                    expected = f"admission linux storage preflight failed: {label}"
                    self.assertEqual(
                        verifier.inspect_admission_readiness(witness, request).value,
                        expected,
                    )
                    supervised = verifier.run_until_ready_and_kill(
                        [sys.executable, "-c", "import time; time.sleep(60)"],
                        witness,
                        request,
                        root / f"{marker}.stdout",
                        root / f"{marker}.stderr",
                        timeout_seconds=2,
                    )
                    self.assertEqual(supervised.value, expected)

            passed = root / "passed"
            write_test_witness(passed, APP_WITNESS_STAGES[:1])
            (passed / LINUX_PREFLIGHT_PASSED).write_bytes(verifier.WITNESS_VALUE)
            outcome, last_stage, temporary_pending = verifier.inspect_admission_witness(passed, request)
            self.assertEqual(outcome, verifier.AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT)
            self.assertEqual(last_stage, LINUX_PREFLIGHT_PASSED)
            self.assertFalse(temporary_pending)

            passed_creation_failure = root / "passed-creation-failure"
            write_test_witness(passed_creation_failure, APP_WITNESS_STAGES[:1])
            (passed_creation_failure / LINUX_PREFLIGHT_PASSED).write_bytes(verifier.WITNESS_VALUE)
            (passed_creation_failure / CREATION_FAILURE_CASES[2][0]).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(passed_creation_failure, request).value,
                CREATION_FAILURE_CASES[2][1],
            )

            passed_creation = root / "passed-creation"
            write_test_witness(passed_creation, APP_WITNESS_STAGES[:2])
            (passed_creation / LINUX_PREFLIGHT_PASSED).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(passed_creation, request),
                verifier.AdmissionOutcome.FIRST_ADMISSION_TIMEOUT,
            )

            no_runtime = root / "no-runtime"
            no_runtime.mkdir()
            (no_runtime / LINUX_PREFLIGHT_PASSED).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(no_runtime, request).value,
                "admission witness invalid: committed",
            )

            duplicate = root / "duplicate-preflight"
            write_test_witness(duplicate, APP_WITNESS_STAGES[:1])
            (duplicate / LINUX_PREFLIGHT_FAILURE_CASES[0][0]).write_bytes(verifier.WITNESS_VALUE)
            (duplicate / LINUX_PREFLIGHT_FAILURE_CASES[1][0]).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(duplicate, request).value,
                "admission witness invalid: inventory",
            )

            contradictory = root / "contradictory-preflight"
            write_test_witness(contradictory, APP_WITNESS_STAGES[:1])
            (contradictory / LINUX_PREFLIGHT_PASSED).write_bytes(verifier.WITNESS_VALUE)
            (contradictory / LINUX_PREFLIGHT_FAILURE_CASES[0][0]).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(contradictory, request).value,
                "admission witness invalid: inventory",
            )

            lookalike = root / "lookalike-preflight"
            write_test_witness(lookalike, APP_WITNESS_STAGES[:1])
            (lookalike / "linux-storage-preflight-failed-parent-open ").write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(lookalike, request).value,
                "admission witness invalid: inventory",
            )

    def test_installed_child_preflight_is_linux_only_separate_and_redacted(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")
        preflight = PREFLIGHT_SOURCE.read_text(encoding="utf-8")
        combined = smoke + preflight

        self.assertIn("LinuxDurableStoragePreflight.Run", smoke)
        self.assertIn("OperatingSystem.IsLinux()", smoke)
        self.assertIn("durable-preflight-parent", smoke)
        self.assertIn("dotnet_durable_storage_preflight.cs", smoke)
        self.assertIn("Directory.Delete(parentPath, recursive: true)", preflight)
        for marker, _label in LINUX_PREFLIGHT_FAILURE_CASES:
            self.assertIn(f'"{marker}"', combined)
        self.assertIn(f'"{LINUX_PREFLIGHT_PASSED}"', combined)
        self.assertIn('EntryPoint = "open"', preflight)
        self.assertIn('EntryPoint = "openat"', preflight)
        self.assertIn('EntryPoint = "mkdirat"', preflight)
        self.assertIn('EntryPoint = "statx"', preflight)
        self.assertIn('EntryPoint = "fchmod"', preflight)
        self.assertIn('EntryPoint = "flock"', preflight)
        self.assertIn("int OpenUnix(string path, int flags);", preflight)
        self.assertIn("int OpenAtUnix(int directoryDescriptor, string path, int flags);", preflight)
        self.assertIn("int OpenAtCreateUnix(int directoryDescriptor, string path, int flags, uint mode);", preflight)
        self.assertIn("Architecture.X64 => 0x10000", preflight)
        self.assertIn("Architecture.Arm64 => 0x4000", preflight)
        self.assertIn("Architecture.X64 => 0x20000", preflight)
        self.assertIn("Architecture.Arm64 => 0x8000", preflight)
        self.assertLess(
            preflight.index("RequireSingleLinkFile(ReadIdentity(owner));"),
            preflight.index("RequireSuccess(ChangeModeUnix"),
        )
        self.assertLess(
            preflight.index("RequireSuccess(ChangeModeUnix"),
            preflight.index("RequirePrivateFile(ReadIdentity(owner));"),
        )
        self.assertNotIn("GetLastPInvokeError().ToString", combined)
        self.assertNotIn("exception.Message", combined)
        self.assertNotIn("exception.StackTrace", combined)

    def test_installed_preflight_reuses_the_product_unix_library_resolver(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")
        preflight = PREFLIGHT_SOURCE.read_text(encoding="utf-8")

        self.assertTrue(UNIX_NATIVE_SOURCE.is_file(), "product Unix native resolver source is missing")
        self.assertIn("DurableUnixNative.cs", smoke)
        self.assertIn("DurableUnixNative.IsAvailable()", preflight)
        self.assertIn('DurableUnixNative.LibraryName', preflight)
