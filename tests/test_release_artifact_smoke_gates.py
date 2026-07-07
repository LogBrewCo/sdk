from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
JS_SMOKE_COMMAND = "bash scripts/real_user_js_release_artifact_smoke.sh"
JS_CLI_SMOKE_COMMAND = "bash scripts/real_user_js_release_artifact_cli_smoke.sh"
VITE_SMOKE_COMMAND = "bash scripts/real_user_vite_release_artifact_smoke.sh"
NEXT_SMOKE_COMMAND = "bash scripts/real_user_next_release_artifact_smoke.sh"
REACT_NATIVE_SMOKE_COMMAND = "bash scripts/real_user_react_native_release_artifact_smoke.sh"
REACT_NATIVE_NATIVE_SMOKE_COMMAND = "bash scripts/real_user_react_native_native_release_artifact_smoke.sh"
JS_UPLOAD_SMOKE_COMMAND = "bash scripts/real_user_js_release_artifact_upload_smoke.sh"
NATIVE_SMOKE_COMMAND = "bash scripts/real_user_native_release_artifact_smoke.sh"
NATIVE_UPLOAD_SMOKE_COMMAND = "bash scripts/real_user_native_release_artifact_upload_smoke.sh"


class ReleaseArtifactSmokeGateTests(unittest.TestCase):
    def test_workflows_run_release_artifact_smoke(self) -> None:
        for workflow in (
            ROOT / ".github" / "workflows" / "ci.yml",
            ROOT / ".github" / "workflows" / "release-readiness.yml",
        ):
            text = workflow.read_text(encoding="utf-8")

            with self.subTest(workflow=workflow.name):
                self.assertIn("Run JavaScript release artifact smoke", text)
                self.assertIn(f"run: {JS_SMOKE_COMMAND}", text)
                self.assertIn("Run JavaScript release artifact installed CLI smoke", text)
                self.assertIn(f"run: {JS_CLI_SMOKE_COMMAND}", text)
                self.assertIn("Run Vite release artifact smoke", text)
                self.assertIn(f"run: {VITE_SMOKE_COMMAND}", text)
                self.assertIn("Run Next.js release artifact smoke", text)
                self.assertIn(f"run: {NEXT_SMOKE_COMMAND}", text)
                self.assertIn("Run React Native release artifact smoke", text)
                self.assertIn(f"run: {REACT_NATIVE_SMOKE_COMMAND}", text)
                self.assertIn("Run React Native native release artifact smoke", text)
                self.assertIn(f"run: {REACT_NATIVE_NATIVE_SMOKE_COMMAND}", text)
                self.assertIn("Run JavaScript release artifact upload smoke", text)
                self.assertIn(f"run: {JS_UPLOAD_SMOKE_COMMAND}", text)
                self.assertIn("Run native release artifact smoke", text)
                self.assertIn(f"run: {NATIVE_SMOKE_COMMAND}", text)
                self.assertIn("Run native release artifact upload smoke", text)
                self.assertIn(f"run: {NATIVE_UPLOAD_SMOKE_COMMAND}", text)

    def test_readiness_checklist_mentions_release_artifact_smoke(self) -> None:
        checklist = (ROOT / "docs" / "sdk-readiness-checklist.md").read_text(encoding="utf-8")

        self.assertIn(f"JavaScript release-artifact dry-run proof: `{JS_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"JavaScript release-artifact installed CLI prep/manifest/frame proof: `{JS_CLI_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"Vite release-artifact installed plugin proof: `{VITE_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"Next.js release-artifact installed helper proof: `{NEXT_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"React Native release-artifact installed helper/build proof: `{REACT_NATIVE_SMOKE_COMMAND}`", checklist)
        self.assertIn(
            f"React Native native release-artifact proof: `{REACT_NATIVE_NATIVE_SMOKE_COMMAND}`",
            checklist,
        )
        self.assertIn(f"JavaScript release-artifact upload proof: `{JS_UPLOAD_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"Native/mobile release-artifact dry-run proof: `{NATIVE_SMOKE_COMMAND}`", checklist)
        self.assertIn(f"Native/mobile release-artifact upload proof: `{NATIVE_UPLOAD_SMOKE_COMMAND}`", checklist)

    def test_native_upload_smoke_proves_unity_zip_transport(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_native_release_artifact_upload_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('--artifact "unity_symbols=$unity_archive"', smoke)
        self.assertIn('"containsUnityZipPart"', smoke)
        self.assertIn('assert all(event["containsUnityZipPart"] for event in events)', smoke)

    def test_react_native_native_smoke_uses_framework_build_paths(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_react_native_native_release_artifact_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("android/app/build/outputs/mapping/release/mapping.txt", smoke)
        self.assertIn("android/app/build/intermediates/merged_native_libs/release/out/lib/arm64-v8a", smoke)
        self.assertIn("ios/build/ReactNativeCheckout.xcarchive/dSYMs/ReactNativeCheckout.app.dSYM", smoke)
        self.assertIn('artifact_types == ["ios_dsym", "android_proguard_mapping", "android_native_symbols"]', smoke)
        self.assertIn('assert tmp_dir not in serialized', smoke)
        self.assertIn('assert "com.logbrew.checkout" not in serialized', smoke)

    def test_vite_smoke_uploads_real_build_artifacts_to_loopback_intake(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_vite_release_artifact_smoke.sh").read_text(encoding="utf-8")

        self.assertIn("js_release_artifact_fake_intake.py", smoke)
        self.assertIn("upload-js \\", smoke)
        self.assertIn('--build-dir "$dist_dir"', smoke)
        self.assertIn('--manifest "$ready_manifest"', smoke)
        self.assertIn("/retry-success", smoke)
        self.assertIn('assert upload_report["status"] == "uploaded"', smoke)
        self.assertIn('assert upload_report["retryCount"] == 1', smoke)
        self.assertIn('assert not any(event["containsSourceSentinel"] for event in events)', smoke)
        self.assertIn('assert not any(event["containsAuthValue"] for event in events)', smoke)

    def test_vite_smoke_links_runtime_browser_error_to_release_artifact_debug_id(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_vite_release_artifact_smoke.sh").read_text(encoding="utf-8")

        self.assertIn('"@logbrew/browser": "file:../logbrew-browser.tgz"', smoke)
        self.assertIn("createBrowserErrorEvent", smoke)
        self.assertIn("createIssueAttributesFromError", smoke)
        self.assertIn("debugIdMap", smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactDebugId"] == debug_id', smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactCodeFile"] == runtime_path', smoke)
        self.assertIn('assert runtime_issue["metadata"]["errorFrameFile"] == runtime_path', smoke)
        self.assertIn("--issue-event", smoke)
        self.assertIn('assert sdk_issue_symbolication["input"]["type"] == "sdk_issue_event"', smoke)
        self.assertIn('assert sdk_issue_symbolication["status"] == "resolved"', smoke)
        self.assertIn('assert sdk_issue_symbolication["original"]["source"].endswith("src/main.js")', smoke)
        self.assertIn('assert "cdn.example" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "cache=placeholder" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "fragment" not in serialized_runtime_issue', smoke)
        self.assertIn("assert tmp_dir not in serialized_runtime_issue", smoke)

    def test_next_smoke_uploads_real_build_artifacts_to_loopback_intake(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_next_release_artifact_smoke.sh").read_text(encoding="utf-8")

        self.assertIn("js_release_artifact_fake_intake.py", smoke)
        self.assertIn("upload-js \\", smoke)
        self.assertIn('--build-dir "$chunks_dir"', smoke)
        self.assertIn('--manifest "$ready_manifest"', smoke)
        self.assertIn("/retry-success", smoke)
        self.assertIn('assert upload_report["status"] == "uploaded"', smoke)
        self.assertIn('assert upload_report["retryCount"] == 1', smoke)
        self.assertIn('assert not any(event["containsSourceSentinel"] for event in events)', smoke)
        self.assertIn('assert not any(event["containsAuthValue"] for event in events)', smoke)

    def test_next_smoke_links_runtime_browser_error_to_release_artifact_debug_id(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_next_release_artifact_smoke.sh").read_text(encoding="utf-8")

        self.assertIn('"@logbrew/browser": "file:../logbrew-browser.tgz"', smoke)
        self.assertIn("createBrowserErrorEvent", smoke)
        self.assertIn("debugIdMap", smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactDebugId"] == debug_id', smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactCodeFile"] == runtime_path', smoke)
        self.assertIn('assert runtime_issue["metadata"]["errorFrameFile"] == runtime_path', smoke)
        self.assertIn('assert "static.example" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "logbrew_next_cache_placeholder" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "logbrew_next_hash_placeholder" not in serialized_runtime_issue', smoke)
        self.assertIn("assert tmp_dir not in serialized_runtime_issue", smoke)

    def test_react_native_smoke_links_runtime_error_to_release_artifact_debug_id(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_react_native_release_artifact_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn('"@logbrew/react-native": "file:../logbrew-react-native.tgz"', smoke)
        self.assertIn("createReactNativeErrorEvent", smoke)
        self.assertIn("debugIdMap", smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactDebugId"] == debug_id', smoke)
        self.assertIn('assert runtime_issue["metadata"]["releaseArtifactCodeFile"] == runtime_path', smoke)
        self.assertIn('assert runtime_issue["metadata"]["errorFrameFile"] == runtime_path', smoke)
        self.assertIn('assert "mobile.example" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "logbrew_rn_query_placeholder" not in serialized_runtime_issue', smoke)
        self.assertIn('assert "logbrew_rn_hash_placeholder" not in serialized_runtime_issue', smoke)
        self.assertIn("assert tmp_dir not in serialized_runtime_issue", smoke)


if __name__ == "__main__":
    unittest.main()
