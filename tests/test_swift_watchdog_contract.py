from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path(
    os.environ.get(
        "LOGBREW_SWIFT_WATCHDOG_CONTRACT_ROOT",
        Path(__file__).resolve().parents[1],
    )
)
SOURCE = ROOT / "swift" / "logbrew-swift" / "Sources" / "LogBrewCrash"
TESTS = ROOT / "swift" / "logbrew-swift" / "Tests" / "LogBrewCrashTests"
PACKAGE = ROOT / "swift" / "logbrew-swift" / "Package.swift"
ROOT_PACKAGE = ROOT / "Package.swift"
CI_WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
PROCESS_HELPER = (
    ROOT
    / "swift"
    / "logbrew-swift"
    / "Tests"
    / "LogBrewHangStoreProcessHelper"
    / "main.swift"
)


class SwiftWatchdogContractTests(unittest.TestCase):
    def test_swift_pr_checks_compile_on_public_macos_runner(self) -> None:
        workflow = CI_WORKFLOW.read_text(encoding="utf-8")
        swift_job = workflow[
            workflow.index("  swift-checks:") : workflow.index("  objc-checks:")
        ]

        self.assertIn("name: Swift SDK checks", swift_job)
        self.assertIn("runs-on: macos-15", swift_job)
        self.assertNotIn("macos-latest", swift_job)
        self.assertIn("run: bash scripts/check_swift_package.sh", swift_job)

    def test_package_owns_bounded_watchdog_components(self) -> None:
        expected_sources = {
            "NativeArtifactIdentity.swift",
            "NativeHangIncidentStore.swift",
            "NativeHangWatchdog.swift",
            "NativeMainThreadStackCapture.swift",
        }
        expected_tests = {
            "NativeArtifactIdentityTests.swift",
            "NativeHangDurationTests.swift",
            "NativeHangIncidentStoreTests.swift",
            "NativeHangWatchdogTests.swift",
            "NativeHangWatchdogRuntimeTests.swift",
        }

        self.assertTrue(expected_sources.issubset({path.name for path in SOURCE.glob("*.swift")}))
        self.assertTrue(expected_tests.issubset({path.name for path in TESTS.glob("*.swift")}))

    def test_watchdog_is_explicit_and_does_not_enable_kscrash_deadlock_monitor(self) -> None:
        public_api = (SOURCE / "NativeCrashPublic.swift").read_text(encoding="utf-8")
        engine = (SOURCE / "CrashEngine.swift").read_text(encoding="utf-8")

        self.assertIn("hangWatchdog: NativeHangWatchdogConfiguration?", public_api)
        self.assertIn("artifactIdentity: NativeArtifactIdentity?", public_api)
        self.assertIn("deadlockWatchdogInterval = 0", engine)

    def test_runtime_identity_uses_exact_backend_tuple_names(self) -> None:
        identity = (SOURCE / "NativeArtifactIdentity.swift").read_text(encoding="utf-8")
        record = (SOURCE / "NativeCrashPublic.swift").read_text(encoding="utf-8")

        for field in ("projectId", "release", "environment", "service"):
            self.assertIn(field, identity)
            self.assertIn(f'"{field}"', record)
        for architecture in ("arm64", "arm64e", "x86_64"):
            self.assertIn(architecture, (ROOT / "swift" / "logbrew-swift" / "Sources" / "LogBrew" / "NativeStackFrame.swift").read_text(encoding="utf-8"))

    def test_watchdog_source_has_no_raw_context_collection(self) -> None:
        watchdog_sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in SOURCE.glob("NativeHang*.swift")
        )

        for forbidden in (
            "allThreads",
            "consoleLog",
            "breadcrumb",
            "userInfo",
            "symbolName",
            "imageName",
        ):
            self.assertNotIn(forbidden, watchdog_sources)

    def test_identity_matches_deployed_context_bounds_without_aliases(self) -> None:
        identity = (SOURCE / "NativeArtifactIdentity.swift").read_text(encoding="utf-8")

        self.assertIn("UUID(uuidString: projectId)?.uuidString.lowercased() == projectId", identity)
        self.assertIn("Self.isExactContext(release)", identity)
        self.assertIn("Self.isExactContext(environment)", identity)
        self.assertIn("Self.isExactContext(service)", identity)
        self.assertIn("(1 ... 256).contains(value.utf8.count)", identity)
        self.assertNotIn("projectID", identity)

    def test_one_explicit_heartbeat_state_owns_terminal_suppression(self) -> None:
        watchdog = (SOURCE / "NativeHangWatchdog.swift").read_text(encoding="utf-8")

        self.assertIn("private enum HangHeartbeatState", watchdog)
        self.assertIn("case suppressed", watchdog)
        self.assertIn(
            "case captured(eventID: String, sentAt: TimeInterval)",
            watchdog,
        )
        for scattered_state in ("heartbeatSentAt", "capturedEventID =", "reportedFailure"):
            self.assertNotIn(scattered_state, watchdog)

    def test_occupied_and_ambiguous_writes_retain_the_first_incident(self) -> None:
        store = (SOURCE / "NativeHangIncidentStore.swift").read_text(encoding="utf-8")
        watchdog = (SOURCE / "NativeHangWatchdog.swift").read_text(encoding="utf-8")

        self.assertIn("guard try readLocked() == nil", store)
        self.assertIn("let persisted = try? store.read()", watchdog)
        self.assertIn("persisted == incident", watchdog)

    def test_hang_duration_uses_the_public_typed_millisecond_contract(self) -> None:
        store = (SOURCE / "NativeHangIncidentStore.swift").read_text(encoding="utf-8")
        watchdog = (SOURCE / "NativeHangWatchdog.swift").read_text(encoding="utf-8")
        record = (SOURCE / "NativeCrashPublic.swift").read_text(encoding="utf-8")

        self.assertIn("durationMs", store)
        self.assertIn("clock.monotonicNow()", watchdog)
        self.assertIn('metadata["durationMs"] = .double', record)
        self.assertNotIn("Date().timeIntervalSince", watchdog)

    def test_process_helper_is_test_only_and_cli_is_explicitly_owned(self) -> None:
        package_description = json.loads(
            subprocess.run(
                [
                    "swift",
                    "package",
                    "--package-path",
                    str(PACKAGE.parent),
                    "dump-package",
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        root_description = json.loads(
            subprocess.run(
                [
                    "swift",
                    "package",
                    "--package-path",
                    str(ROOT),
                    "dump-package",
                ],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        store_tests = (
            TESTS / "NativeHangIncidentStoreTests.swift"
        ).read_text(encoding="utf-8")
        self.assertTrue(PROCESS_HELPER.is_file())
        helper = PROCESS_HELPER.read_text(encoding="utf-8")

        for description in (package_description, root_description):
            self.assertNotIn(
                "LogBrewHangStoreProcessHelper",
                {product["name"] for product in description["products"]},
            )
            targets = {target["name"]: target for target in description["targets"]}
            self.assertEqual(
                targets["LogBrewHangStoreProcessHelper"]["type"],
                "executable",
            )
            test_dependencies = targets["LogBrewCrashTests"]["dependencies"]
            self.assertTrue(
                any(
                    dependency.get("byName", [None])[0]
                    == "LogBrewHangStoreProcessHelper"
                    for dependency in test_dependencies
                )
            )
        self.assertIn(
            "process.executableURL = try NativeHangIncidentProcessHarness.executableURL()",
            store_tests,
        )
        self.assertIn(
            "process.arguments = NativeHangIncidentProcessHarness.arguments(",
            store_tests,
        )
        self.assertNotIn("CommandLine.arguments.dropFirst", store_tests)
        self.assertNotIn("--testing-library", store_tests)
        for flag in ("--phase", "--directory", "--result"):
            self.assertIn(f'"{flag}"', helper)
        self.assertIn("incident.makeRecord(ownerNonce: UUID()).enqueue", helper)
        self.assertIn('metadata["durationMs"] as? Double', helper)

    def test_timer_and_app_callback_lifecycles_have_single_safe_owners(self) -> None:
        watchdog = (SOURCE / "NativeHangWatchdog.swift").read_text(encoding="utf-8")

        self.assertIn("private enum HangTimerLifecycleState", watchdog)
        self.assertIn("case prepared", watchdog)
        self.assertIn("case active", watchdog)
        self.assertIn("case stopped", watchdog)
        self.assertIn("final class OrderedHangDiagnosticDelivery", watchdog)
        self.assertNotIn("diagnosticLock", watchdog)


if __name__ == "__main__":
    unittest.main()
