package main

import "os"

const (
	publicationArtifactsFamily = "publication-artifacts"
	publicationWorkflow        = ".github/workflows/publish-packages.yml"
)

func checkPublicationArtifacts(root *os.Root) bool {
	packages, packagesRead := readReleaseMetadata(root, publicationWorkflow)
	nuget, nugetRead := readReleaseMetadata(root, nugetPublicationWorkflow)
	publisher, publisherRead := readReleaseMetadata(root, npmPublisherPath)
	if !packagesRead || !nugetRead || !publisherRead ||
		parseMetadataYAML(packages) == nil || parseMetadataYAML(nuget) == nil {
		return false
	}
	combined := append(append([]byte(nil), packages...), nuget...)
	return validMetadataText(combined, publicationArtifactRequirements()) &&
		validPublicationCatalog(combined, packages) && validPublicationMaven(packages) &&
		validPublicationNPM(packages, publisher)
}

func validPublicationCatalog(combined, packages []byte) bool {
	for _, pkg := range dotnetMetadataPackages() {
		if !validMetadataText(combined, []string{nugetVersionOutput(pkg.id) + "="}) {
			return false
		}
	}
	for directory := range jsMetadataPackages() {
		if !validMetadataText(packages, []string{directory}) {
			return false
		}
	}
	for _, pkg := range pythonReleaseCatalog() {
		if !validMetadataText(packages, []string{pkg.directory}) {
			return false
		}
	}
	return true
}

func publicationArtifactRequirements() []string {
	return []string{
		"id: nuget-version",
		"dotnet pack dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
		nativeProbeInvocation + " nuget-plan create", nativeProbeInvocation + " nuget-plan validate",
		"--format projects", "-p:GenerateDocumentationFile=true", "httpclient_pack_args=",
		"-p:SymbolPackageFormat=snupkg", "-p:RepositoryCommit=$source_commit", "-p:EnableSourceLink=true",
		"python3 scripts/check_dotnet_release_artifacts.py", "steps.nuget-artifacts.outputs.httpclient_content_sha256",
		"--expect-absent", `--dependency-range "LogBrew.HttpClient:LogBrew=`,
		"real_user_dotnet_httpclient_package_compatibility_smoke.sh", "while IFS= read -r package_path",
		"--skip-duplicate", "--symbol-source https://api.nuget.org/v3/index.json",
		"bash scripts/real_user_dotnet_selected_public_nuget_smoke.sh",
		"bash scripts/real_user_dotnet_aspnetcore_public_nuget_smoke.sh",
		"python-archive create-manifest", nativeProbeInvocation + " python-public-consumer --manifest",
		"--artifact-root dist/pypi", "Upload Python release manifest", "Verify public PyPI installs",
		"logbrew-flask=${{ steps.pypi-version.outputs.flask_version }}",
		"LOGBREW_SWIFTPM_EXPECTED_REVISION", "LOGBREW_SWIFTPM_EXPECTED_SOURCE_SHA256",
		"real_user_swiftpm_public_smoke.sh", "verify_version:", `verify_args+=(--version "$VERIFY_VERSION")`,
		"verify_args=(--target all --require-released-package-set)",
		`append_values --npm-version "$VERIFY_NPM_VERSIONS"`, `append_values --pypi-version "$VERIFY_PYPI_VERSIONS"`,
		`append_values --nuget-version "$VERIFY_NUGET_VERSIONS"`, "verify_maven_artifacts:", "verify_maven_versions:",
		`append_values --maven-artifact "$VERIFY_MAVEN_ARTIFACTS"`,
		`append_values --maven-version "$VERIFY_MAVEN_VERSIONS"`,
		`-n "$VERIFY_MAVEN_ARTIFACTS" || -n "$VERIFY_MAVEN_VERSIONS"`,
		"id: crate-version", "python3 scripts/read_rust_crate_version.py rust/logbrew/Cargo.toml",
		`--target crates --version "${{ steps.crate-version.outputs.version }}"`,
		"bash scripts/real_user_maven_central_public_smoke.sh",
		"bash scripts/check_maven_central_auth_preflight.sh", "generated Central Portal publishing values",
		"- name: Bind immutable Maven release source", "- name: Check out protected Maven release control",
		"ref: ${{ github.workflow_sha }}", "path: .release-control", "- name: Bind protected Maven release control",
		"capture --deployment-id-file", "wait --deployment-id-file", "--timeout-seconds 3600",
		"maven_artifacts:", "maven_release_plan.py create", "MAVEN_ARTIFACTS_INPUT: ${{ inputs.maven_artifacts }}",
		"--artifacts-env MAVEN_ARTIFACTS_INPUT", "--maven-plan-scope selected", "--maven-plan-scope dependencies",
		"--manifest", "real_user_maven_central_public_smoke.sh --plan",
	}
}
