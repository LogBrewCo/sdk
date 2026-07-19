import importlib.util
import io
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
CI = ROOT / ".github" / "workflows" / "ci.yml"
PACKAGE_CHECK = ROOT / "scripts" / "check_dotnet_package.sh"
SMOKE = ROOT / "scripts" / "real_user_dotnet_durable_delivery_smoke.sh"
VERIFIER = ROOT / "scripts" / "dotnet_durable_delivery_verifier.py"
APP_WITNESS_STAGES = (
    "runtime-validated",
    "durable-client-created",
    "first-admission-persisted",
    "second-admission-persisted",
    "retry-observed",
    "pending-verified",
)
RECOVERY_WITNESS_STAGES = (
    "recovery-runtime-validated",
    "recovery-client-created",
    "recovery-accepted",
    "recovery-pending-empty",
    "recovery-health-ready",
    "recovery-shutdown-complete",
)
CREATION_FAILURE_CASES = (
    (
        "durable-client-failed-validation",
        "admission durable client creation failed: validation",
    ),
    (
        "durable-client-failed-configuration",
        "admission durable client creation failed: configuration",
    ),
    (
        "durable-client-failed-storage",
        "admission durable client creation failed: storage",
    ),
    (
        "durable-client-failed-state",
        "admission durable client creation failed: state",
    ),
    (
        "durable-client-failed-sdk-unknown",
        "admission durable client creation failed: sdk-unknown",
    ),
    (
        "durable-client-failed-non-sdk",
        "admission durable client creation failed: non-sdk",
    ),
)
LINUX_PREFLIGHT_PASSED = "linux-storage-preflight-passed"
LINUX_PREFLIGHT_FAILURE_CASES = (
    ("linux-storage-preflight-failed-native-bind", "native-bind"),
    ("linux-storage-preflight-failed-parent-open-missing", "parent-open-missing"),
    ("linux-storage-preflight-failed-parent-open-denied", "parent-open-denied"),
    ("linux-storage-preflight-failed-parent-open-invalid", "parent-open-invalid"),
    ("linux-storage-preflight-failed-parent-open-other", "parent-open-other"),
    ("linux-storage-preflight-failed-parent-statx", "parent-statx"),
    ("linux-storage-preflight-failed-child-mkdir-open", "child-mkdir-open"),
    ("linux-storage-preflight-failed-child-statx", "child-statx"),
    ("linux-storage-preflight-failed-owner-create-open", "owner-create-open"),
    ("linux-storage-preflight-failed-owner-statx-mode", "owner-statx-mode"),
    ("linux-storage-preflight-failed-owner-lock", "owner-lock"),
    ("linux-storage-preflight-failed-root-remove", "root-remove"),
)


def load_verifier():
    spec = importlib.util.spec_from_file_location("dotnet_durable_delivery_verifier", VERIFIER)
    if spec is None or spec.loader is None:
        raise AssertionError("durability verifier helper could not be loaded")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_test_witness(root: Path, stages: tuple[str, ...] = APP_WITNESS_STAGES) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for stage in stages:
        (root / stage).write_text("observed", encoding="ascii")


class DotnetDurableDeliveryWorkflowGateTests(unittest.TestCase):
    def test_fake_intake_startup_does_not_resolve_loopback_name(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            with mock.patch(
                "socket.getfqdn",
                side_effect=AssertionError("host name lookup used"),
            ):
                server = verifier.create_intake_server(
                    Path(temporary_directory),
                    "Bearer fixed-test-value",
                )
            try:
                self.assertGreater(server.server_address[1], 0)
            finally:
                server.server_close()

    def test_windows_local_feed_uses_native_file_uri(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        source = verifier.local_package_source(
            r"C:\fixed\packages",
            platform_name="windows",
        )

        self.assertEqual(source, "file:///C:/fixed/packages")
        self.assertNotIn("\\", source)

        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "NuGet.config"
            verifier.write_nuget_config(
                r"C:\fixed\packages",
                config_path,
                platform_name="windows",
            )
            configuration = ET.parse(config_path).getroot()
            local_source = configuration.find("./packageSources/add[@key='local-logbrew']")
            local_mapping = configuration.find("./packageSourceMapping/packageSource[@key='local-logbrew']/package")

            self.assertIsNotNone(local_source)
            self.assertEqual(local_source.get("value"), source)
            self.assertIsNotNone(local_mapping)
            self.assertEqual(local_mapping.get("pattern"), "LogBrew")

    def test_admission_readiness_reports_each_fixed_stage(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        expected_missing = (
            verifier.AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT,
            verifier.AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT,
            verifier.AdmissionOutcome.FIRST_ADMISSION_TIMEOUT,
            verifier.AdmissionOutcome.SECOND_ADMISSION_TIMEOUT,
            verifier.AdmissionOutcome.RETRY_OBSERVATION_TIMEOUT,
            verifier.AdmissionOutcome.PENDING_VERIFICATION_TIMEOUT,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            witness.mkdir()
            for index, expected in enumerate(expected_missing):
                self.assertEqual(
                    verifier.inspect_admission_readiness(witness, request),
                    expected,
                )
                (witness / APP_WITNESS_STAGES[index]).write_text(
                    "observed",
                    encoding="ascii",
                )

            self.assertEqual(
                verifier.inspect_admission_readiness(witness, request),
                verifier.AdmissionOutcome.REQUEST_TIMEOUT,
            )
            request.write_bytes(b"request")
            self.assertIsNone(verifier.inspect_admission_readiness(witness, request))

            (witness / "unexpected-stage").write_text("observed", encoding="ascii")
            self.assertEqual(
                verifier.inspect_admission_readiness(witness, request).value,
                "admission witness invalid: inventory",
            )

    def test_recovery_witness_reports_only_a_valid_fixed_prefix(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "recovery"
            witness.mkdir()
            self.assertEqual(verifier.inspect_recovery_witness(witness), "none")
            for stage in RECOVERY_WITNESS_STAGES:
                (witness / stage).write_bytes(verifier.WITNESS_VALUE)
                self.assertEqual(verifier.inspect_recovery_witness(witness), stage)

            (witness / "unexpected").write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(verifier.inspect_recovery_witness(witness), "invalid")

            malformed = root / "malformed-recovery"
            write_test_witness(malformed, RECOVERY_WITNESS_STAGES[:1])
            (malformed / RECOVERY_WITNESS_STAGES[1]).write_bytes(b"unsafe")
            self.assertEqual(verifier.inspect_recovery_witness(malformed), "invalid")

            publishing = root / "publishing-recovery"
            write_test_witness(publishing, RECOVERY_WITNESS_STAGES[:1])
            (publishing / verifier.WITNESS_TEMPORARY_NAME).write_bytes(b"obs")
            self.assertEqual(verifier.inspect_recovery_witness(publishing), "invalid")

    def test_external_kill_classification_is_fixed_and_redacted(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        expected_labels = {
            "admission runtime validation timeout",
            "admission durable client creation timeout",
            "admission first persistence timeout",
            "admission second persistence timeout",
            "admission retry observation timeout",
            "admission pending verification timeout",
            "admission request timeout",
            "admission spontaneous exit after none",
            "admission spontaneous exit after runtime-validated",
            "admission spontaneous exit after durable-client-created",
            "admission spontaneous exit after first-admission-persisted",
            "admission spontaneous exit after second-admission-persisted",
            "admission spontaneous exit after retry-observed",
            "admission spontaneous exit after pending-verified",
            "admission kill request failed",
            "admission zero exit",
            "admission expected nonzero exit",
            "admission reap failed",
            "admission witness invalid: committed",
            "admission witness invalid: inventory",
            "admission witness invalid: publication",
            "admission witness invalid: supervisor",
            "admission durable client creation failed: validation",
            "admission durable client creation failed: configuration",
            "admission durable client creation failed: storage",
            "admission durable client creation failed: state",
            "admission durable client creation failed: sdk-unknown",
            "admission durable client creation failed: non-sdk",
            "admission spontaneous exit after linux-storage-preflight-passed",
            *(f"admission linux storage preflight failed: {label}" for _marker, label in LINUX_PREFLIGHT_FAILURE_CASES),
        }
        self.assertEqual(
            {outcome.value for outcome in verifier.AdmissionOutcome},
            expected_labels,
        )

        for outcome in verifier.AdmissionOutcome:
            stderr = io.StringIO()
            with (
                mock.patch.object(
                    verifier,
                    "run_until_ready_and_kill",
                    return_value=outcome,
                ),
                mock.patch("sys.stderr", stderr),
            ):
                status = verifier.main(["kill-after-ready", "a", "b", "c", "d", "5", "--", "child"])
            if outcome == verifier.AdmissionOutcome.EXPECTED_NONZERO_EXIT:
                self.assertEqual(status, 0)
                self.assertEqual(stderr.getvalue(), "")
            else:
                self.assertEqual(status, 1)
                self.assertEqual(stderr.getvalue(), f"{outcome.value}\n")

    def test_external_kill_supervisor_covers_process_outcomes(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            stdout_path = root / "stdout"
            stderr_path = root / "stderr"
            child = (
                "from pathlib import Path; import signal, sys, time; "
                "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                "root=Path(sys.argv[1]); root.mkdir(); "
                "[(root / stage).write_text('observed', encoding='ascii') "
                "for stage in sys.argv[3].split(',')]; "
                "Path(sys.argv[2]).write_bytes(b'request'); "
                "time.sleep(60)"
            )

            result = verifier.run_until_ready_and_kill(
                [
                    sys.executable,
                    "-c",
                    child,
                    str(witness),
                    str(request),
                    ",".join(APP_WITNESS_STAGES),
                ],
                witness,
                request,
                stdout_path,
                stderr_path,
                timeout_seconds=5,
            )

            self.assertEqual(result, verifier.AdmissionOutcome.EXPECTED_NONZERO_EXIT)
            self.assertTrue((witness / "external-kill-requested").is_file())
            self.assertTrue((witness / "post-kill-reaped").is_file())
            self.assertEqual(stdout_path.read_bytes(), b"")
            self.assertEqual(stderr_path.read_bytes(), b"")

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            child = "raise SystemExit(7)"
            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", child],
                witness,
                request,
                root / "stdout",
                root / "stderr",
                timeout_seconds=2,
            )
            self.assertEqual(result.value, "admission spontaneous exit after none")

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            write_test_witness(witness)
            request.write_bytes(b"request")

            def fail_kill(_process) -> None:
                raise OSError("fixed failure")

            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                witness,
                request,
                root / "stdout",
                root / "stderr",
                timeout_seconds=2,
                kill_request=fail_kill,
            )
            self.assertEqual(result, verifier.AdmissionOutcome.KILL_REQUEST_FAILED)

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            trigger = root / "trigger"
            write_test_witness(witness)
            request.write_bytes(b"request")
            child = (
                "from pathlib import Path; import sys, time; "
                "trigger=Path(sys.argv[1])\n"
                "while not trigger.exists():\n"
                "    time.sleep(0.01)\n"
            )

            def request_zero_exit(_process) -> None:
                trigger.write_text("requested", encoding="ascii")

            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", child, str(trigger)],
                witness,
                request,
                root / "stdout",
                root / "stderr",
                timeout_seconds=2,
                kill_request=request_zero_exit,
            )
            self.assertEqual(result, verifier.AdmissionOutcome.ZERO_EXIT)
            self.assertTrue((witness / "external-kill-requested").is_file())
            self.assertTrue((witness / "post-kill-reaped").is_file())

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            request = root / "request"
            write_test_witness(witness)
            request.write_bytes(b"request")
            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                witness,
                request,
                root / "stdout",
                root / "stderr",
                timeout_seconds=2,
                reap_timeout_seconds=0.05,
                kill_request=lambda _process: None,
            )
            self.assertEqual(result, verifier.AdmissionOutcome.REAP_FAILED)

    def test_spontaneous_exit_preserves_every_fixed_witness_stage(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        for stage_count in range(len(APP_WITNESS_STAGES) + 1):
            last_stage = "none" if stage_count == 0 else APP_WITNESS_STAGES[stage_count - 1]
            with (
                self.subTest(last_stage=last_stage),
                tempfile.TemporaryDirectory() as temporary_directory,
            ):
                root = Path(temporary_directory)
                witness = root / "witness"
                request = root / "request"
                child = (
                    "from pathlib import Path; import sys; "
                    "root=Path(sys.argv[1]); root.mkdir(); "
                    "[(root / stage).write_text('observed', encoding='ascii') "
                    "for stage in sys.argv[2].split(',') if stage]; "
                    "raise SystemExit(7)"
                )

                result = verifier.run_until_ready_and_kill(
                    [
                        sys.executable,
                        "-c",
                        child,
                        str(witness),
                        ",".join(APP_WITNESS_STAGES[:stage_count]),
                    ],
                    witness,
                    request,
                    root / "stdout",
                    root / "stderr",
                    timeout_seconds=2,
                )

                self.assertEqual(
                    result.value,
                    f"admission spontaneous exit after {last_stage}",
                )

    def test_durable_client_creation_failures_are_fixed_and_ordered(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            request = root / "request"
            for marker, expected in CREATION_FAILURE_CASES:
                with self.subTest(marker=marker):
                    witness = root / marker
                    write_test_witness(witness, APP_WITNESS_STAGES[:1])
                    (witness / marker).write_bytes(verifier.WITNESS_VALUE)
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

            missing_runtime = root / "missing-runtime"
            missing_runtime.mkdir()
            (missing_runtime / CREATION_FAILURE_CASES[0][0]).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(missing_runtime, request).value,
                "admission witness invalid: committed",
            )

            after_creation = root / "after-creation"
            write_test_witness(after_creation, APP_WITNESS_STAGES[:2])
            (after_creation / CREATION_FAILURE_CASES[0][0]).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(after_creation, request).value,
                "admission witness invalid: committed",
            )

            duplicate = root / "duplicate"
            write_test_witness(duplicate, APP_WITNESS_STAGES[:1])
            for marker, _expected in CREATION_FAILURE_CASES[:2]:
                (duplicate / marker).write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(duplicate, request).value,
                "admission witness invalid: inventory",
            )

            malformed = root / "malformed-creation-failure"
            write_test_witness(malformed, APP_WITNESS_STAGES[:1])
            (malformed / CREATION_FAILURE_CASES[0][0]).write_bytes(b"invalid")
            self.assertEqual(
                verifier.inspect_admission_readiness(malformed, request).value,
                "admission witness invalid: committed",
            )

            lookalike = root / "lookalike"
            write_test_witness(lookalike, APP_WITNESS_STAGES[:1])
            (lookalike / "durable-client-failed-storage_error").write_bytes(verifier.WITNESS_VALUE)
            self.assertEqual(
                verifier.inspect_admission_readiness(lookalike, request).value,
                "admission witness invalid: inventory",
            )

            publication = root / "creation-failure-publication"
            write_test_witness(publication, APP_WITNESS_STAGES[:1])
            (publication / CREATION_FAILURE_CASES[0][0]).write_bytes(verifier.WITNESS_VALUE)
            (publication / verifier.WITNESS_TEMPORARY_NAME).write_bytes(b"obs")
            self.assertEqual(
                verifier.inspect_admission_readiness(publication, request).value,
                "admission witness invalid: publication",
            )

            normal = root / "normal-creation"
            write_test_witness(normal, APP_WITNESS_STAGES[:2])
            self.assertEqual(
                verifier.inspect_admission_readiness(normal, request),
                verifier.AdmissionOutcome.FIRST_ADMISSION_TIMEOUT,
            )

    def test_installed_child_maps_only_fixed_creation_error_codes(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")

        expected_mappings = {
            "validation_error": "durable-client-failed-validation",
            "configuration_error": "durable-client-failed-configuration",
            "storage_error": "durable-client-failed-storage",
            "state_error": "durable-client-failed-state",
        }
        for code, marker in expected_mappings.items():
            self.assertIn(f'"{code}" => "{marker}"', smoke)
        self.assertIn('_ => "durable-client-failed-sdk-unknown"', smoke)
        self.assertIn('catch (SdkException error)', smoke)
        self.assertIn('catch (Exception)', smoke)
        self.assertIn('"durable-client-failed-non-sdk"', smoke)
        self.assertIn("Environment.ExitCode = 1;", smoke)
        self.assertNotIn("error.Message", smoke)
        self.assertNotIn("error.DetailMessage", smoke)
        self.assertNotIn("error.GetType", smoke)
        self.assertNotIn("error.StackTrace", smoke)

    def test_invalid_supervisor_witness_writes_have_fixed_reason(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        for failed_stage in verifier.SUPERVISOR_WITNESS_STAGES:
            with (
                self.subTest(failed_stage=failed_stage),
                tempfile.TemporaryDirectory() as temporary_directory,
            ):
                root = Path(temporary_directory)
                witness = root / "witness"
                request = root / "request"
                write_test_witness(witness)
                request.write_bytes(b"request")

                def fail_selected_stage(_witness, stage: str) -> None:
                    if stage == failed_stage:
                        raise OSError("fixed failure")

                with mock.patch.object(
                    verifier,
                    "record_witness_stage",
                    side_effect=fail_selected_stage,
                ):
                    result = verifier.run_until_ready_and_kill(
                        [sys.executable, "-c", "import time; time.sleep(60)"],
                        witness,
                        request,
                        root / "stdout",
                        root / "stderr",
                        timeout_seconds=2,
                    )

                self.assertEqual(
                    result.value,
                    "admission witness invalid: supervisor",
                )

    def test_completed_readiness_with_live_temporary_exit_is_publication_invalid(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        class ExitedProcess:
            def poll(self) -> int:
                return 7

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            with (
                mock.patch.object(
                    verifier,
                    "inspect_admission_witness",
                    return_value=(None, "pending-verified", True),
                ),
                mock.patch.object(
                    verifier.subprocess,
                    "Popen",
                    return_value=ExitedProcess(),
                ),
            ):
                result = verifier.run_until_ready_and_kill(
                    ["fixed-child"],
                    root / "witness",
                    root / "request",
                    root / "stdout",
                    root / "stderr",
                    timeout_seconds=2,
                )

            self.assertEqual(
                result.value,
                "admission witness invalid: publication",
            )

    def test_admission_witness_rejects_invalid_surfaces(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            request = root / "request"
            self.assertEqual(
                verifier.inspect_admission_readiness(root / "missing", request),
                verifier.AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT,
            )

            malformed = root / "malformed"
            malformed.mkdir()
            (malformed / APP_WITNESS_STAGES[0]).write_bytes(b"invalid")
            self.assertEqual(
                verifier.inspect_admission_readiness(malformed, request).value,
                "admission witness invalid: committed",
            )

            completed_prefix = root / "completed-prefix"
            write_test_witness(completed_prefix)
            (completed_prefix / verifier.WITNESS_TEMPORARY_NAME).write_bytes(b"observed")
            self.assertEqual(
                verifier.inspect_admission_readiness(completed_prefix, request).value,
                "admission witness invalid: publication",
            )

            for index, temporary_value in enumerate((b"", b"obs", b"observed")):
                in_progress = root / f"in-progress-{index}"
                write_test_witness(in_progress, APP_WITNESS_STAGES[:1])
                (in_progress / verifier.WITNESS_TEMPORARY_NAME).write_bytes(temporary_value)
                self.assertEqual(
                    verifier.inspect_admission_witness(in_progress, request),
                    (
                        verifier.AdmissionOutcome.DURABLE_CLIENT_CREATION_TIMEOUT,
                        "runtime-validated",
                        True,
                    ),
                )

            invalid_temporary = root / "invalid-temporary"
            write_test_witness(invalid_temporary, APP_WITNESS_STAGES[:1])
            (invalid_temporary / verifier.WITNESS_TEMPORARY_NAME).write_bytes(b"obx")
            self.assertEqual(
                verifier.inspect_admission_readiness(invalid_temporary, request).value,
                "admission witness invalid: publication",
            )

            oversized_temporary = root / "oversized-temporary"
            write_test_witness(oversized_temporary, APP_WITNESS_STAGES[:1])
            (oversized_temporary / verifier.WITNESS_TEMPORARY_NAME).write_bytes(b"observed-extra")
            self.assertEqual(
                verifier.inspect_admission_readiness(oversized_temporary, request).value,
                "admission witness invalid: publication",
            )

            oversized = root / "oversized"
            oversized.mkdir()
            (oversized / APP_WITNESS_STAGES[0]).write_bytes(b"observed-extra")
            with mock.patch.object(
                Path,
                "read_bytes",
                side_effect=AssertionError("oversized witness was read without a bound"),
            ):
                self.assertEqual(
                    verifier.inspect_admission_readiness(oversized, request).value,
                    "admission witness invalid: committed",
                )

            out_of_order = root / "out-of-order"
            write_test_witness(out_of_order, APP_WITNESS_STAGES[1:2])
            self.assertEqual(
                verifier.inspect_admission_readiness(out_of_order, request).value,
                "admission witness invalid: committed",
            )

            unknown = root / "unknown"
            unknown.mkdir()
            (unknown / "unknown-stage").write_bytes(b"observed")
            self.assertEqual(
                verifier.inspect_admission_readiness(unknown, request).value,
                "admission witness invalid: inventory",
            )

            supervisor_stage = root / "supervisor-stage"
            write_test_witness(supervisor_stage, APP_WITNESS_STAGES[:1])
            (supervisor_stage / "external-kill-requested").write_bytes(b"observed")
            self.assertEqual(
                verifier.inspect_admission_readiness(supervisor_stage, request).value,
                "admission witness invalid: inventory",
            )

            unreadable = root / "unreadable"
            unreadable.mkdir()
            with mock.patch.object(Path, "iterdir", side_effect=OSError("fixed failure")):
                self.assertEqual(
                    verifier.inspect_admission_readiness(unreadable, request).value,
                    "admission witness invalid: inventory",
                )

            dead_temporary = root / "dead-temporary"
            child = (
                "from pathlib import Path; import sys; "
                "root=Path(sys.argv[1]); root.mkdir(); "
                "(root / '.stage.tmp').write_bytes(b'obs'); "
                "raise SystemExit(7)"
            )
            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", child, str(dead_temporary)],
                dead_temporary,
                request,
                root / "dead.stdout",
                root / "dead.stderr",
                timeout_seconds=2,
            )
            self.assertEqual(result.value, "admission witness invalid: publication")

    def test_temporary_witness_uses_one_bounded_open_handle_snapshot(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        class ChangingSizeStream(io.BytesIO):
            def fileno(self) -> int:
                return 1

        class ChangingSizePath:
            def __init__(self, value: bytes) -> None:
                self.value = value

            def is_symlink(self) -> bool:
                return False

            def stat(self, *, follow_symlinks: bool = True):
                del follow_symlinks
                return mock.Mock(st_mode=verifier.stat.S_IFREG, st_size=0)

            def open(self, mode: str) -> ChangingSizeStream:
                self.assert_read_mode(mode)
                return ChangingSizeStream(self.value)

            @staticmethod
            def assert_read_mode(mode: str) -> None:
                if mode != "rb":
                    raise AssertionError("temporary witness was not opened read-only")

        opened_metadata = mock.Mock(st_mode=verifier.stat.S_IFREG, st_size=0)
        with mock.patch.object(verifier.os, "fstat", return_value=opened_metadata):
            for value, expected in (
                (b"obs", True),
                (b"obx", False),
                (b"observedx", False),
            ):
                with self.subTest(value=value):
                    self.assertEqual(
                        verifier._is_valid_temporary_witness(ChangingSizePath(value)),
                        expected,
                    )

    def test_atomic_temporary_publication_requires_committed_progress(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            request = root / "request"
            original_open = Path.open

            published = root / "published"
            write_test_witness(published, APP_WITNESS_STAGES[:1])
            published_temporary = published / verifier.WITNESS_TEMPORARY_NAME
            published_temporary.write_bytes(verifier.WITNESS_VALUE)

            def publish_before_open(path: Path, *args, **kwargs):
                if path == published_temporary and path.exists():
                    path.replace(published / APP_WITNESS_STAGES[1])
                return original_open(path, *args, **kwargs)

            with mock.patch.object(Path, "open", new=publish_before_open):
                self.assertEqual(
                    verifier.inspect_admission_witness(published, request),
                    (
                        verifier.AdmissionOutcome.FIRST_ADMISSION_TIMEOUT,
                        "durable-client-created",
                        False,
                    ),
                )

            vanished = root / "vanished"
            write_test_witness(vanished, APP_WITNESS_STAGES[:1])
            vanished_temporary = vanished / verifier.WITNESS_TEMPORARY_NAME
            vanished_temporary.write_bytes(verifier.WITNESS_VALUE)

            def remove_before_open(path: Path, *args, **kwargs):
                if path == vanished_temporary and path.exists():
                    path.unlink()
                return original_open(path, *args, **kwargs)

            with mock.patch.object(Path, "open", new=remove_before_open):
                self.assertEqual(
                    verifier.inspect_admission_readiness(vanished, request).value,
                    "admission witness invalid: publication",
                )

            exhausted = root / "exhausted"
            write_test_witness(exhausted, APP_WITNESS_STAGES[:1])
            exhausted_temporary = exhausted / verifier.WITNESS_TEMPORARY_NAME
            exhausted_temporary.write_bytes(verifier.WITNESS_VALUE)

            def exhaust_before_open(path: Path, *args, **kwargs):
                if path == exhausted_temporary and path.exists():
                    path.unlink()
                return original_open(path, *args, **kwargs)

            with mock.patch.object(Path, "open", new=exhaust_before_open):
                self.assertEqual(
                    verifier.inspect_admission_witness(
                        exhausted,
                        request,
                        _publication_retry_allowed=False,
                    )[0].value,
                    "admission witness invalid: publication",
                )

    def test_admission_timeout_distinguishes_witness_and_request(self) -> None:
        self.assertTrue(VERIFIER.is_file(), "durability verifier helper is missing")
        verifier = load_verifier()

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                root / "witness",
                root / "request",
                root / "stdout",
                root / "stderr",
                timeout_seconds=0.05,
            )
            self.assertEqual(
                result,
                verifier.AdmissionOutcome.RUNTIME_VALIDATION_TIMEOUT,
            )

        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            witness = root / "witness"
            write_test_witness(witness)
            result = verifier.run_until_ready_and_kill(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                witness,
                root / "request",
                root / "stdout",
                root / "stderr",
                timeout_seconds=0.05,
            )
            self.assertEqual(result, verifier.AdmissionOutcome.REQUEST_TIMEOUT)

    def test_installed_smoke_binds_package_and_restart_delivery(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")
        verifier = VERIFIER.read_text(encoding="utf-8")

        for expected in (
            "dotnet pack",
            "NUGET_PACKAGES",
            "sha256:",
            "CreateAutomaticDurable",
            "DurableDeliveryKey",
            "DurableDeliveryOptions",
            '"admit"',
            '"recover"',
            "dotnet_durable_delivery_verifier.py",
            "kill-after-ready",
            "serve-intake",
            "write-nuget-config",
            '"runtime-validated"',
            '"durable-client-created"',
            '"first-admission-persisted"',
            '"second-admission-persisted"',
            '"retry-observed"',
            '"pending-verified"',
            "RecordAdmissionWitness",
            "Thread.Sleep(Timeout.Infinite)",
            "cmp",
            "MaxQueueSize = 1000",
            "MaxQueueBytes = 4 * 1024 * 1024",
            "FlushAtQueueSize = 2",
            "DeliveryHealth",
            "PurgeDurableDelivery",
            "lib/netstandard2.0/LogBrew.dll",
            "lib/net8.0/LogBrew.dll",
            "LOGBREW_DURABLE_SMOKE_TIMEOUT_SECONDS",
            "LOGBREW_EXPECTED_DURABLE_OS",
            "LOGBREW_EXPECTED_DURABLE_ARCHITECTURE",
            "LOGBREW_EXPECTED_DURABLE_RUNTIME_MAJOR",
            "RuntimeInformation.ProcessArchitecture",
            "Environment.Version.Major",
            "installed runtime environment mismatch",
            '"runtime identity negative probe"',
            "runtime-identity-negative.stdout",
            "runtime-identity-negative.stderr",
            'grep -Fq "installed runtime environment mismatch"',
        ):
            self.assertIn(expected, smoke)

        self.assertNotIn("Environment.Exit(0)", smoke)
        self.assertNotIn("run_admission_until_ready", smoke)
        self.assertNotIn('fail_stage "admission hard exit"', smoke)
        self.assertNotIn("HTTPServer", smoke)
        self.assertNotIn('<add key="local-logbrew" value="$packages_dir"', smoke)
        for expected in (
            "packageSourceMapping",
            "socketserver.TCPServer",
            "PureWindowsPath",
            "process.kill()",
            "AdmissionOutcome",
            "external-kill-requested",
            "post-kill-reaped",
            "503",
            "202",
        ):
            self.assertIn(expected, verifier)
        for stage in (
            "package build",
            "package identity",
            "asset extraction",
            "installed app feed configuration",
            "installed app dependency resolution",
            "installed app build",
            "runtime identity negative output",
            "asset inspection output",
            "fake intake startup",
            "admission output",
            "external kill witness validation",
            "post-kill reap witness validation",
            "encrypted storage validation",
            "recovery output",
            "fake intake completion",
            "retry body identity",
            "accepted storage validation",
        ):
            self.assertIn(f'"{stage}"', smoke)

        self.assertLess(
            smoke.index('"runtime identity negative probe"'),
            smoke.index('"asset inspection"'),
        )

    def test_temporary_witness_allows_cross_process_read_during_publication(self) -> None:
        smoke = SMOKE.read_text(encoding="utf-8")
        writer_start = smoke.index("static void RecordAdmissionWitness")
        writer_end = smoke.index("static string ClassifyDurableClientCreationFailure")
        witness_writer = smoke[writer_start:writer_end]

        self.assertIn("FileShare.Read", witness_writer)
        self.assertNotIn("FileShare.None", witness_writer)
        self.assertIn("FileOptions.WriteThrough", witness_writer)
        self.assertIn("stream.Flush(flushToDisk: true)", witness_writer)
        self.assertIn("File.Move(temporaryPath, finalPath)", witness_writer)

    def test_package_check_requires_both_core_assets(self) -> None:
        package_check = PACKAGE_CHECK.read_text(encoding="utf-8")

        self.assertIn('"lib/netstandard2.0/LogBrew.dll"', package_check)
        self.assertIn('"lib/net8.0/LogBrew.dll"', package_check)
        self.assertIn('"CreateAutomaticDurable"', package_check)
        self.assertIn('"DurableDeliveryOptions"', package_check)

    def test_ci_runs_six_supported_durability_pairs_on_dotnet_8(self) -> None:
        workflow = CI.read_text(encoding="utf-8")

        for expected in (
            "dotnet-durability:",
            "- runner: ubuntu-24.04\n            os: linux\n            architecture: x64",
            "- runner: ubuntu-24.04-arm\n            os: linux\n            architecture: arm64",
            "- runner: macos-15-intel\n            os: macos\n            architecture: x64",
            "- runner: macos-15\n            os: macos\n            architecture: arm64",
            "- runner: windows-2025\n            os: windows\n            architecture: x64",
            "- runner: windows-11-arm\n            os: windows\n            architecture: arm64",
            'dotnet-version: "8.0.x"',
            "LOGBREW_EXPECTED_DURABLE_OS: ${{ matrix.os }}",
            "LOGBREW_EXPECTED_DURABLE_ARCHITECTURE: ${{ matrix.architecture }}",
            'LOGBREW_EXPECTED_DURABLE_RUNTIME_MAJOR: "8"',
            "bash scripts/real_user_dotnet_durable_delivery_smoke.sh",
        ):
            self.assertIn(expected, workflow)


if __name__ == "__main__":
    unittest.main()
