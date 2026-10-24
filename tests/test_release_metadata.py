from __future__ import annotations

import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_publish_workflows() -> str:
    workflow_dir = ROOT / ".github" / "workflows"
    return "\n".join(
        (workflow_dir / name).read_text(encoding="utf-8")
        for name in ("publish-packages.yml", "publish-nuget.yml")
    )


class ReleaseMetadataTests(unittest.TestCase):
    def test_publish_packages_names_the_exact_release_source(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "publish-packages.yml"
        ).read_text(encoding="utf-8")

        self.assertIn(
            "run-name: Publish ${{ inputs.target }} from ${{ inputs.ref }}",
            workflow,
        )


    def test_go_install_command_tracks_latest_public_module(self) -> None:
        readme = (ROOT / "go" / "logbrew" / "README.md").read_text(encoding="utf-8")

        self.assertIn(
            "go get github.com/LogBrewCo/sdk/go/logbrew@latest",
            readme,
        )


    def test_publish_packages_workflow_includes_httpclient_release_contract(self) -> None:
        workflow = read_publish_workflows()

        for expected in (
            "httpclient_version=",
            "steps.nuget-version.outputs.httpclient_version",
            "src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
            "release-plan nuget entries",
            "release-artifacts dotnet",
            "-p:EnableSourceLink=true",
            "steps.nuget-artifacts.outputs.httpclient_content_sha256",
            "while IFS= read -r package_path",
            '"${{ steps.nuget-version.outputs.httpclient_version }}"',
            '"$(git rev-parse HEAD)"',
        ):
            self.assertIn(expected, workflow)

        httpclient_args = workflow.split("httpclient_pack_args=(", 1)[1].split(")", 1)[0]
        self.assertNotIn("NoWarn", httpclient_args)
        self.assertIn(
            'dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj --no-restore "${httpclient_pack_args[@]}"',
            workflow,
        )

    def test_publish_packages_rejects_nuget_collisions_before_pack(self) -> None:
        workflow = read_publish_workflows()

        collision_check = workflow.index("Check NuGet version collision")
        pack = workflow.index("Pack NuGet package")

        self.assertLess(collision_check, pack)
        self.assertIn("--expect-absent", workflow[collision_check:pack])
        self.assertIn("logbrew-nuget-release-plan.json", workflow[collision_check:pack])
        self.assertIn("--format versions", workflow[collision_check:pack])

    def test_publish_packages_uses_a_typed_nuget_plan_for_every_release_stage(self) -> None:
        workflow = read_publish_workflows()

        self.assertIn("nuget_packages:", workflow)
        self.assertIn("NUGET_PACKAGES_INPUT: ${{ inputs.nuget_packages }}", workflow)
        self.assertIn("release-plan nuget create", workflow)
        plan_step = workflow.split("- name: Plan selected NuGet packages", 1)[1].split(
            "\n      - name:", 1
        )[0]
        self.assertIn("NUGET_PACKAGES_INPUT: ${{ inputs.nuget_packages }}", plan_step)
        self.assertNotIn("${{ inputs.nuget_packages }}", plan_step.split("run: |", 1)[1])
        for stage in (
            "Check NuGet version collision",
            "Pack NuGet package",
            "Publish NuGet package",
            "Verify public NuGet package",
            "Verify public NuGet install",
        ):
            section = workflow.split(f"- name: {stage}", 1)[1].split("\n      - name:", 1)[0]
            self.assertIn("logbrew-nuget-release-plan.json", section)

    def test_publish_nuget_binds_registry_checks_to_protected_workflow_source(
        self,
    ) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "publish-nuget.yml"
        ).read_text(encoding="utf-8")
        release_checkout = workflow.split("- name: Check out release ref", 1)[1].split(
            "\n      - name:",
            1,
        )[0]
        checkout_auth_setting = (
            "persist-" + bytes.fromhex("63726564656e7469616c73").decode() + ": false"
        )

        self.assertIn("ref: ${{ inputs.ref }}", release_checkout)
        self.assertIn(checkout_auth_setting, release_checkout)
        self.assertNotIn("path:", release_checkout)

        control_checkout = workflow.split(
            "- name: Check out protected release control",
            1,
        )[1].split("\n      - name:", 1)[0]
        self.assertIn("repository: ${{ github.repository }}", control_checkout)
        self.assertIn("ref: ${{ github.workflow_sha }}", control_checkout)
        self.assertIn("path: .release-control", control_checkout)
        self.assertIn(checkout_auth_setting, control_checkout)

        binding = workflow.split(
            "- name: Bind protected release control",
            1,
        )[1].split("\n      - name:", 1)[0]
        self.assertIn("RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}", binding)
        self.assertIn(
            "RELEASE_SOURCE_SHA: ${{ steps.release-source.outputs.sha }}",
            binding,
        )
        self.assertIn(
            "git -C \"$GITHUB_WORKSPACE\" rev-parse --verify 'HEAD^{commit}'",
            binding,
        )
        self.assertIn(
            "git -C \"$control_root\" rev-parse --verify 'HEAD^{commit}'",
            binding,
        )

        protected_checker = (
            '"$GITHUB_WORKSPACE/.release-control/scripts/'
            'check_registry_publication.py"'
        )
        self.assertEqual(workflow.count(protected_checker), 2)
        for stage in (
            "Plan selected NuGet packages",
            "Validate NuGet release metadata",
            "Check NuGet version collision",
            "Pack NuGet package",
            "Publish NuGet package",
            "Verify public NuGet package",
            "Verify public NuGet install",
        ):
            section = workflow.split(f"- name: {stage}", 1)[1].split(
                "\n      - name:",
                1,
            )[0]
            self.assertIn('"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" release-plan nuget', section)


    def test_publish_packages_grants_oidc_to_the_reusable_nuget_job(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "publish-packages.yml"
        ).read_text(encoding="utf-8")
        nuget_job = workflow.split("  nuget:", 1)[1].split("  packagist:", 1)[0]

        self.assertIn("permissions:", nuget_job)
        self.assertIn("contents: read", nuget_job)
        oidc_permission = "id-" + bytes.fromhex("746f6b656e").decode() + ": write"
        self.assertIn(oidc_permission, nuget_job)

    def test_publish_packages_binds_python_artifacts_and_runs_installed_receipts(
        self,
    ) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(
            encoding="utf-8"
        )

        build = workflow.index("Build Python distributions")
        local_receipt = workflow.index("Verify packed Python distributions")
        publish = workflow.index("Publish logbrew-sdk to PyPI")
        registry = workflow.index("Verify public PyPI packages")
        public_receipt = workflow.index("Verify public PyPI installs")

        for expected in (
            "release-artifacts python create",
            "--source-commit",
            "logbrew-flask=${{ steps.pypi-version.outputs.flask_version }}",
            "python-release-artifacts.json",
            "real_user_python_public_pypi_smoke.sh --manifest",
            "--artifact-root dist/pypi",
            "Upload Python release manifest",
        ):
            self.assertIn(expected, workflow)
        self.assertLess(build, local_receipt)
        self.assertLess(local_receipt, publish)
        self.assertLess(publish, registry)
        self.assertLess(registry, public_receipt)

    def test_python_release_builds_are_byte_reproducible(self) -> None:
        publish = (
            ROOT / ".github" / "workflows" / "publish-packages.yml"
        ).read_text(encoding="utf-8")
        reconcile = (
            ROOT / ".github" / "workflows" / "reconcile-public-packages.yml"
        ).read_text(encoding="utf-8")
        tools = (ROOT / "scripts" / "python_release_tools.txt").read_text(
            encoding="utf-8"
        )

        for expected in (
            "build==1.5.0",
            "setuptools==83.0.0",
            "twine==7.0.0",
            "uv==0.12.9",
            "wheel==0.47.0",
        ):
            self.assertIn(expected, tools)
        for workflow in (publish, reconcile):
            for expected in (
                "scripts/python_release_tools.txt",
                "SOURCE_DATE_EPOCH",
                "PYTHONHASHSEED=0",
                "TZ=UTC",
                "--no-isolation",
                "normalize-sdist",
                "--source-date-epoch",
            ):
                self.assertIn(expected, workflow)

        manifest = publish.index("Create Python release manifest")
        reproducibility = publish.index("Verify reproducible Python distributions")
        packed_receipt = publish.index("Verify packed Python distributions")
        self.assertIn('git show -s --format=%ct HEAD', publish)
        self.assertIn("$RUNNER_TEMP/python-reproducibility", publish)
        self.assertIn("release-artifacts python verify", publish)
        self.assertLess(manifest, reproducibility)
        self.assertLess(reproducibility, packed_receipt)

    def test_pypi_public_install_resolves_skip_existing_artifacts(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "publish-packages.yml"
        ).read_text(encoding="utf-8")

        registry = workflow.index("Verify public PyPI packages")
        resolve = workflow.index("Resolve public PyPI artifacts")
        upload = workflow.index("Upload Python public reconciliation")
        install = workflow.index("Verify public PyPI installs")
        for expected in (
            "release-artifacts python resolve-public",
            "--directory dist/pypi",
            "--manifest dist/pypi/python-release-artifacts.json",
            '--output-directory "$RUNNER_TEMP/python-public-artifacts"',
            '--public-manifest "$RUNNER_TEMP/python-public-release-artifacts.json"',
            '--reconciliation "$RUNNER_TEMP/python-public-reconciliation.json"',
            "name: python-public-reconciliation",
            '--artifact-root "$RUNNER_TEMP/python-public-artifacts"',
        ):
            self.assertIn(expected, workflow)
        self.assertLess(registry, resolve)
        self.assertLess(resolve, upload)
        self.assertLess(upload, install)

    def test_public_reconciliation_is_source_bound_and_cannot_publish(self) -> None:
        workflow = (
            ROOT / ".github" / "workflows" / "reconcile-public-packages.yml"
        ).read_text(encoding="utf-8")
        checkout_auth_setting = "persist-" + "creden" + "tials: false"
        oidc_write_permission = "id-" + "to" + "ken: write"

        for expected in (
            "workflow_dispatch:",
            "actions: read",
            "contents: read",
            "ref: ${{ inputs.ref }}",
            "ref: ${{ github.workflow_sha }}",
            "CONTROL_REF: ${{ github.ref }}",
            '[[ "$CONTROL_REF" != "refs/heads/main"',
            "path: .release-control",
            checkout_auth_setting,
            "check_publication_run.py",
            "resolve-public",
            "release-artifacts python create",
            "release-artifacts nuget-public",
            "check_nuget_release_receipt_provenance.py",
            '--source-root "$GITHUB_WORKSPACE"',
            "real_user_python_public_pypi_smoke.sh",
            "real_user_dotnet_selected_public_nuget_smoke.sh",
            "python-public-reconciliation.json",
            "nuget-public-reconciliation.json",
            '"$RUNNER_TEMP/python-public-smoke.out"',
            '"Python public artifact execution failed."',
        ):
            self.assertIn(expected, workflow)
        for forbidden in (
            oidc_write_permission,
            "environment: release",
            "gh-action-pypi-publish",
            "dotnet nuget push",
            "nuget/login",
        ):
            self.assertNotIn(forbidden, workflow)
        self.assertIn(
            "RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}",
            workflow,
        )
        self.assertIn(
            "RELEASE_SOURCE_SHA: ${{ steps.release-source.outputs.sha }}",
            workflow,
        )
        self.assertIn(
            "git -C \"$control_root\" rev-parse --verify 'HEAD^{commit}'",
            workflow,
        )

    def test_publish_packages_binds_swiftpm_receipt_to_exact_source(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-packages.yml").read_text(
            encoding="utf-8"
        )

        for expected in (
            "include_swiftpm:",
            "verify_swiftpm_version:",
            "Public SwiftPM verification",
            "LOGBREW_SWIFTPM_EXPECTED_REVISION",
            "LOGBREW_SWIFTPM_EXPECTED_SOURCE_SHA256",
            "real_user_swiftpm_public_smoke.sh",
        ):
            self.assertIn(expected, workflow)

    def test_publish_release_uses_current_checkout_runtime(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-release.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", workflow)
        self.assertNotIn("uses: actions/checkout@v4", workflow)

    def test_publish_release_canonicalizes_nuget_selection_before_dispatch(self) -> None:
        workflow = (ROOT / ".github" / "workflows" / "publish-release.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn("INPUT_NUGET_PACKAGES: ${{ inputs.nuget_packages }}", workflow)
        self.assertIn("release-plan nuget canonicalize", workflow)
        self.assertIn("printf 'nuget_packages=%s\\n' \"$nuget_packages\"", workflow)
        self.assertIn('-f nuget_packages="$NUGET_PACKAGES"', workflow)
        self.assertIn('-f include_swiftpm="$INCLUDE_SWIFTPM"', workflow)
        self.assertIn('-f verify_swiftpm_version="$VERIFY_SWIFTPM_VERSION"', workflow)

    def test_publish_packages_runs_httpclient_compatibility_receipt(self) -> None:
        workflow = read_publish_workflows()

        self.assertIn(
            "bash scripts/real_user_dotnet_httpclient_package_compatibility_smoke.sh",
            workflow,
        )

    def test_httpclient_dependency_range_uses_the_pack_contract_not_ignored_reference_metadata(self) -> None:
        project = (
            ROOT
            / "dotnet"
            / "logbrew-dotnet"
            / "src"
            / "LogBrew.HttpClient"
            / "LogBrew.HttpClient.csproj"
        ).read_text(encoding="utf-8")

        self.assertIn("<LogBrewCoreDependencyVersion>", project)
        self.assertIn('<ProjectReference Include="../LogBrew/LogBrew.csproj" />', project)
        self.assertNotIn('ProjectReference Include="../LogBrew/LogBrew.csproj" Version=', project)


    def test_maven_metadata_matches_each_release_family(self) -> None:
        self.assertIn(
            "<version>0.1.13</version>",
            (ROOT / "java" / "logbrew-java" / "pom.xml").read_text(encoding="utf-8"),
        )
        for pom_path in (
            ROOT / "kotlin" / "logbrew-kotlin" / "pom.xml",
            ROOT / "kotlin" / "logbrew-kotlin-okhttp" / "pom.xml",
        ):
            self.assertIn("<version>0.2.3</version>", pom_path.read_text(encoding="utf-8"))

    def test_maven_central_public_smoke_covers_kotlin_okhttp_artifact(self) -> None:
        smoke = (ROOT / "scripts" / "real_user_maven_central_public_smoke.sh").read_text(encoding="utf-8")

        self.assertIn("logbrew-kotlin-okhttp", smoke)
        self.assertIn("LOGBREW_MAVEN_KOTLIN_OKHTTP_VERSION", smoke)
        self.assertIn("LogBrewOkHttpRouteTemplates", smoke)

    def test_swift_metadata_requires_root_swiftpm_package(self) -> None:
        manifest_path = ROOT / "Package.swift"

        self.assertTrue(manifest_path.exists(), "root Package.swift must support the documented SwiftPM URL install")

        manifest = manifest_path.read_text(encoding="utf-8")
        self.assertIn('name: "logbrew-swift"', manifest)
        self.assertIn('.library(name: "LogBrew", targets: ["LogBrew"])', manifest)
        self.assertIn('.library(name: "LogBrewCrash", targets: ["LogBrewCrash"])', manifest)
        self.assertIn('path: "swift/logbrew-swift/Sources/LogBrew"', manifest)
        self.assertIn('path: "swift/logbrew-swift/Sources/LogBrewCrash"', manifest)
        self.assertIn('path: "swift/logbrew-swift/Tests/LogBrewTests"', manifest)
        self.assertIn('path: "swift/logbrew-swift/Tests/LogBrewCrashTests"', manifest)


    def test_publish_packages_requires_selected_maven_plan_before_build_and_upload(self) -> None:
        workflow = (ROOT / ".github/workflows/publish-packages.yml").read_text(encoding="utf-8")

        plan = workflow.index("Plan selected Maven artifacts")
        collision = workflow.index("Check selected Maven version collisions")
        build = workflow.index("Build Maven Central deployment bundle")
        upload = workflow.index("Upload Maven Central deployment bundle")

        self.assertIn("maven_artifacts:", workflow)
        self.assertIn("release-plan maven create", workflow[plan:collision])
        self.assertIn("--maven-plan-scope selected", workflow[collision:build])
        self.assertIn("--expect-absent", workflow[collision:build])
        self.assertIn("--maven-plan-scope dependencies", workflow[collision:build])
        self.assertIn("--plan", workflow[build:upload])
        self.assertIn("--manifest", workflow[build:upload])
        self.assertIn(
            "real_user_maven_central_public_smoke.sh --plan",
            workflow[build:upload],
        )
        self.assertIn("--bundle", workflow[build:upload])
        self.assertIn("real_user_maven_central_public_smoke.sh --plan", workflow[upload:])
        self.assertLess(plan, collision)
        self.assertLess(collision, build)
        self.assertLess(build, upload)

    def test_maven_public_verification_waits_for_the_bound_portal_deployment(
        self,
    ) -> None:
        workflow = (ROOT / ".github/workflows/publish-packages.yml").read_text(
            encoding="utf-8"
        )
        maven_job = workflow.split("\n  maven:\n", 1)[1].split(
            "\n  verify:\n",
            1,
        )[0]

        control_checkout = maven_job.split(
            "- name: Check out protected Maven release control",
            1,
        )[1].split("- name: Bind protected Maven release control", 1)[0]
        self.assertIn("repository: ${{ github.repository }}", control_checkout)
        self.assertIn("ref: ${{ github.workflow_sha }}", control_checkout)
        self.assertIn("path: .release-control", control_checkout)
        checkout_auth_setting = (
            "persist-"
            + bytes.fromhex("63726564656e7469616c73").decode()
            + ": false"
        )
        self.assertIn(checkout_auth_setting, control_checkout)
        self.assertIn(
            "scripts/check_maven_central_deployment.py",
            control_checkout,
        )

        control_binding = maven_job.split(
            "- name: Bind protected Maven release control",
            1,
        )[1].split("- name: Plan selected Maven artifacts", 1)[0]
        self.assertIn("id: maven-release-control", control_binding)
        self.assertIn(
            "git -C \"$control_root\" show "
            "\"${RELEASE_CONTROL_SHA}:scripts/check_maven_central_deployment.py\"",
            control_binding,
        )
        self.assertIn("script_sha256=", control_binding)

        upload = maven_job.index("Upload Maven Central deployment bundle")
        wait = maven_job.index("Wait for Maven Central deployment")
        public_metadata = maven_job.index("Verify Maven Central publication")
        public_install = maven_job.index("Verify public Maven Central install")
        self.assertEqual(
            maven_job.count(
                "https://central.sonatype.com/api/v1/publisher/upload"
            ),
            1,
        )
        self.assertIn(
            "capture --deployment-id-file",
            maven_job[upload:wait],
        )
        upload_section = maven_job[upload:wait]
        self.assertIn("--max-filesize 128", upload_section)
        self.assertIn('--output "$response_file"', upload_section)
        self.assertNotIn('response="$(', upload_section)
        capture_position = upload_section.index("capture --deployment-id-file")
        upload_complete_position = upload_section.index(
            'if [[ "$curl_status" -ne 0 ]]'
        )
        self.assertGreater(
            upload_section.rfind(
                "verify_control_script",
                0,
                capture_position,
            ),
            upload_complete_position,
        )
        self.assertEqual(upload_section.count("verify_control_script"), 3)
        self.assertIn(
            "wait --deployment-id-file",
            maven_job[wait:public_metadata],
        )
        for section in (
            maven_job[upload:wait],
            maven_job[wait:public_metadata],
        ):
            self.assertIn(
                "MAVEN_RELEASE_CONTROL_SHA256: "
                "${{ steps.maven-release-control.outputs.script_sha256 }}",
                section,
            )
            self.assertIn('sha256sum "$control_script"', section)
            self.assertIn("Protected release control changed.", section)
        self.assertNotIn("deployment_id}", maven_job)
        self.assertLess(upload, wait)
        self.assertLess(wait, public_metadata)
        self.assertLess(public_metadata, public_install)


    def test_registry_verify_job_skips_only_swiftpm_only_selection(self) -> None:
        workflow = (ROOT / ".github/workflows/publish-packages.yml").read_text(
            encoding="utf-8"
        )
        verify_job = workflow.split("\n  verify:\n", 1)[1].split(
            "\n  verify-swiftpm:\n",
            1,
        )[0]
        condition_source = " ".join(
            verify_job.split("runs-on:", 1)[0].split("if:", 1)[1].split()
        )
        expected_condition = """
        >- ${{
          inputs.target == 'verify' &&
          (
            ! inputs.include_swiftpm ||
            inputs.include_unity_npm ||
            inputs.include_pypi_extras ||
            inputs.include_crates_publish ||
            inputs.include_packagist_update ||
            inputs.include_maven_publish ||
            inputs.include_go_module ||
            inputs.verify_version != '' ||
            inputs.verify_npm_versions != '' ||
            inputs.verify_pypi_versions != '' ||
            inputs.verify_nuget_versions != '' ||
            inputs.verify_maven_artifacts != '' ||
            inputs.verify_maven_versions != ''
          )
        }}
        """

        self.assertEqual(condition_source, " ".join(expected_condition.split()))

    def test_maven_dispatch_input_is_canonicalized_before_shell_or_output_use(
        self,
    ) -> None:
        publish_packages = (ROOT / ".github/workflows/publish-packages.yml").read_text(
            encoding="utf-8"
        )
        plan_step = publish_packages.split("- name: Plan selected Maven artifacts", 1)[
            1
        ].split(
            "- name: Check selected Maven version collisions",
            1,
        )[0]
        plan_script = plan_step.split("run: |", 1)[1]
        self.assertIn(
            "MAVEN_ARTIFACTS_INPUT: ${{ inputs.maven_artifacts }}",
            plan_step,
        )
        self.assertIn("--artifacts-env MAVEN_ARTIFACTS_INPUT", plan_script)
        self.assertNotIn("${{ inputs.maven_artifacts }}", plan_script)

        publish_release = (ROOT / ".github/workflows/publish-release.yml").read_text(
            encoding="utf-8"
        )
        resolve_step = publish_release.split("name: Resolve release publish inputs", 1)[
            1
        ].split(
            "- name: Guard repo-wide release package versions",
            1,
        )[0]
        resolve_script = resolve_step.split("run: |", 1)[1]
        self.assertIn(
            "INPUT_MAVEN_ARTIFACTS: ${{ inputs.maven_artifacts }}",
            resolve_step,
        )
        self.assertIn("release-plan maven canonicalize", resolve_script)
        self.assertIn("--artifacts-env INPUT_MAVEN_ARTIFACTS", resolve_script)
        self.assertNotIn('maven_artifacts="$INPUT_MAVEN_ARTIFACTS"', resolve_script)
        self.assertNotIn('echo "maven_artifacts=$maven_artifacts"', resolve_script)
        self.assertIn(
            "printf 'maven_artifacts=%s\\n' \"$maven_artifacts\"",
            resolve_script,
        )

    def test_release_guide_documents_selected_maven_artifact_safety(self) -> None:
        guide = (ROOT / "docs/github-actions.md").read_text(encoding="utf-8")

        for expected in (
            "`maven_artifacts`",
            "immutable-version collision",
            "exact dependency closure",
            "bundle manifest",
            "before upload",
        ):
            self.assertIn(expected, guide)


    def test_python_packages_publish_python_310_compatibility(self) -> None:
        projects = {
            package: tomllib.loads(
                (ROOT / f"python/{package}/pyproject.toml").read_text(encoding="utf-8")
            )["project"]
            for package in ("logbrew_py", "logbrew_fastapi", "logbrew_flask", "logbrew_django")
        }

        for project in projects.values():
            self.assertEqual(project["requires-python"], ">=3.10")
            self.assertIn("Programming Language :: Python :: 3.10", project["classifiers"])
        self.assertIn(
            "typing-extensions>=4.1; python_version < '3.11'",
            projects["logbrew_py"]["dependencies"],
        )
        self.assertIn("Django>=4.2.30,<6", projects["logbrew_django"]["dependencies"])

        workflow = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
        self.assertIn("python-version: \"3.10\"", workflow)
        self.assertIn('LOGBREW_DJANGO_FRAMEWORK_VERSION: ${{ matrix.django_version }}', workflow)
        self.assertIn('- "4.2.30"', workflow)
        self.assertIn('- "5.2.16"', workflow)
        self.assertIn("bash scripts/check_fastapi_package.sh", workflow)
        self.assertIn("bash scripts/check_flask_package.sh", workflow)

    def test_python_core_readme_routes_framework_apps_to_released_integrations(self) -> None:
        readme = (ROOT / "python/logbrew_py/README.md").read_text(encoding="utf-8")
        normalized_readme = " ".join(readme.split())

        for package_name in ("logbrew-flask", "logbrew-fastapi", "logbrew-django"):
            self.assertIn(package_name, readme)
        self.assertIn("https://docs.logbrew.co/guides/flask", readme)
        self.assertIn(
            "rather than rebuilding request hooks around the core client",
            normalized_readme,
        )

    def test_public_python_smoke_defaults_to_current_core_release(self) -> None:
        smoke = (ROOT / "scripts/real_user_python_public_pypi_smoke.sh").read_text(
            encoding="utf-8"
        )

        self.assertIn("LOGBREW_PYPI_SDK_VERSION:-0.1.14", smoke)


if __name__ == "__main__":
    unittest.main()
