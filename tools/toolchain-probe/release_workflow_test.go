package main

import (
	"strings"
	"testing"
)

func TestNativePackageReleaseIdentities(t *testing.T) {
	t.Parallel()
	for path, declaration := range map[string]string{
		"c/logbrew-c/include/logbrew.h":       `#define LOGBREW_C_VERSION "0.2.2"`,
		"cpp/logbrew-cpp/include/logbrew.hpp": `inline constexpr const char *version = "0.2.3"`,
		"objc/logbrew-objc/src/LogBrew.m":     `LogBrewObjectiveCVersion = @"0.2.3"`,
	} {
		requireSourceText(t, repositorySource(t, path), declaration)
	}
	if !checkPackageDocument([]byte(repositorySource(t, "unity/logbrew-unity/package.json")), jsonFields,
		[]string{`name="co.logbrew.unity"`, `version="0.2.2"`}) {
		t.Fatal("Unity package identity differs from its release matrix")
	}
}

func TestPublicReceiptVersionDefaults(t *testing.T) {
	t.Parallel()
	for path, required := range map[string][]string{
		"scripts/real_user_go_public_module_smoke.sh": {
			"LOGBREW_GO_MODULE_VERSION:-v0.1.10", "LOGBREW_GO_GIN_MODULE_VERSION:-v0.1.2",
		},
		"scripts/real_user_go_gin_smoke.sh":         {"github.com/LogBrewCo/sdk/go/logbrew/gin@v0.1.2"},
		"scripts/real_user_swiftpm_public_smoke.sh": {"LOGBREW_SWIFTPM_VERSION:-0.1.15"},
		"swift/logbrew-swift/README.md":             {`from: "0.1.15"`},
		"scripts/real_user_npm_public_registry_smoke.sh": {
			"LOGBREW_NPM_SDK_VERSION:-0.1.17", "LOGBREW_NPM_BROWSER_VERSION:-0.1.3",
			"LOGBREW_NPM_NODE_VERSION:-0.1.11", "LOGBREW_NPM_NEXT_VERSION:-0.1.7",
			"LOGBREW_NPM_REACT_VERSION:-0.1.1", "LOGBREW_NPM_REACT_NATIVE_VERSION:-0.1.20",
		},
		"scripts/real_user_cratesio_public_smoke.sh":  {"LOGBREW_CRATESIO_VERSION:-0.1.7"},
		"scripts/real_user_rubygems_public_smoke.sh":  {"LOGBREW_RUBYGEMS_VERSION:-0.1.14"},
		"scripts/real_user_packagist_public_smoke.sh": {"LOGBREW_PACKAGIST_VERSION:-0.1.10"},
		mavenPublicSmoke: {
			"LOGBREW_MAVEN_JAVA_VERSION:-0.1.8", "LOGBREW_MAVEN_KOTLIN_VERSION:-0.2.2",
		},
		"scripts/real_user_dotnet_public_nuget_smoke.sh": {
			"LOGBREW_DOTNET_CORE_VERSION:-0.1.7", "LOGBREW_DOTNET_HTTPCLIENT_VERSION:-0.1.2",
		},
	} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()
			requireSourceText(t, repositorySource(t, path), required...)
		})
	}
}

func TestNextInstrumentationTypeConsumerInputs(t *testing.T) {
	t.Parallel()
	requireSourceText(t, repositorySource(t, "scripts/real_user_next_smoke.sh"),
		"@types/react", "@types/react-dom", "cat > instrumentation-consumer.ts",
		"--lib ESNext,DOM,DOM.Iterable", "--skipLibCheck true", "Instrumentation.onRequestError",
	)
}

func TestReleaseArtifactReceiptCallers(t *testing.T) {
	t.Parallel()
	for family, script := range map[string]string{
		"crates":     "cratesio_public",
		"go":         "go_public_module",
		"maven":      "maven_central_public",
		"npm-nestjs": "nestjs_public_registry",
		"nuget":      "dotnet_selected_public_nuget",
		"packagist":  "packagist_public",
		"rubygems":   "rubygems_public",
		"swiftpm":    "swiftpm_public",
	} {
		t.Run(family, func(t *testing.T) {
			t.Parallel()
			body := repositorySource(t, "scripts/real_user_"+script+"_smoke.sh")
			requireSourceText(t, body,
				"LOGBREW_RELEASE_RECEIPT_MODE", `release_artifact_receipt.py" bind`,
				`--family "`+family+`"`, `release_artifact_receipt.py" attest`, "run_receipt_smoke",
				`receipt_mode="${LOGBREW_RELEASE_RECEIPT_MODE:-0}"`,
			)
		})
	}
}

func TestNugetBoundReceiptSourceContract(t *testing.T) {
	t.Parallel()
	body := repositorySource(t, "scripts/real_user_dotnet_selected_public_nuget_smoke.sh")
	requireSourceText(t, body,
		`ln "$bound/0.nupkg" "$source_dir/LogBrew.${core_version}.nupkg"`, `ln "$bound/1.nupkg"`,
		`"$source_dir/LogBrew.HttpClient.${httpclient_version}.nupkg"`,
		`<add key="receipt" value="$source_dir" />`,
		`"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" nuget-provenance`,
	)
	for _, forbidden := range []string{
		`<add key="receipt" value="$bound" />`,
		`"$repo_root/scripts/check_nuget_release_receipt_provenance.py"`,
	} {
		if strings.Contains(body, forbidden) {
			t.Errorf("receipt uses an unbound package or provenance source: %s", forbidden)
		}
	}
}

func TestProtectedRegistryVerification(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	for _, name := range []string{"verify", "verify-swiftpm"} {
		job := workflowJob(t, workflow, name)
		requireSourceText(t, job,
			"ref: ${{ inputs.ref }}", "ref: ${{ github.workflow_sha }}", "path: .release-control",
			"RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}",
			"RELEASE_SOURCE_SHA: ${{ steps.verify-source.outputs.sha }}",
			`git -C "$GITHUB_WORKSPACE" rev-parse --verify 'HEAD^{commit}'`,
			`git -C "$control_root" rev-parse --verify 'HEAD^{commit}'`,
		)
		if strings.Count(job, "persist-credentials: false") < 2 {
			t.Error("both verification checkouts must discard authentication state")
		}
	}
	registry := workflowJob(t, workflow, "verify")
	requireOrderedSource(t, registry, "Set up Go for module verification", "Bind immutable verify source")
	requireSourceText(t, registry,
		"verify_args=(--target all --require-released-package-set)",
		nativeProbeInvocation+" "+registryCommand)
	requireOrderedSource(t, registry, "Bind protected verify control",
		"Build protected native registry verifier", "Verify public registry packages")
	swift := workflowJob(t, workflow, "verify-swiftpm")
	requireSourceText(t, swift, `"$GITHUB_WORKSPACE/.release-control/scripts/real_user_swiftpm_public_smoke.sh"`)
	for _, path := range []string{
		releaseMetadataScript,
		"scripts/release_metadata_dotnet.py", "scripts/real_user_swiftpm_public_smoke.sh",
		"scripts/check_sdk_parity.py", "fixtures/valid-batch.json",
	} {
		requireSourceText(t, workflow, path)
	}
}

func TestProtectedNativeFixtureControl(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	swift := workflowJob(t, workflow, "verify-swiftpm")
	requireSourceText(t, swift,
		"spec/event-batch.schema.json", "tools/toolchain-probe/.go-version",
		"tools/toolchain-probe/go.mod", "tools/toolchain-probe/go.sum", "tools/toolchain-probe/main.go",
		"tools/toolchain-probe/action.yml", "uses: ./.release-control/tools/toolchain-probe",
	)
	requireOrderedSource(t, swift, "Build protected native verifier", "Verify public Swift products")
	if strings.Contains(workflow, "validate_fixtures.py") {
		t.Error("registry verification retains the legacy fixture control")
	}
	smoke := repositorySource(t, "scripts/real_user_swiftpm_public_smoke.sh")
	requireSourceText(t, smoke,
		`source "$repo_root/scripts/native_verifier.sh"`,
		`run_native_verifier event-batch-check "$repo_root/spec/event-batch.schema.json"`,
	)
	if strings.Contains(smoke, "validate_fixtures.py") {
		t.Error("Swift consumer still invokes the legacy validator")
	}
}

func TestNativeVerifierBootstrap(t *testing.T) {
	t.Parallel()
	bootstrap := repositorySource(t, "tools/toolchain-probe/action.yml")
	requireSourceText(t, bootstrap,
		"using: composite", `native_root="$GITHUB_ACTION_PATH"`,
		`export GOENV=off GOWORK=off GOFLAGS=-mod=readonly`,
		`! -d "$native_root" || -L "$native_root" || -L "${native_root%/*}"`,
		`! -f "$native_file" || -L "$native_file"`,
		`for native_file in "$native_root"/*.go "$native_root"/.go-version `+
			`"$native_root"/go.mod "$native_root"/go.sum; do`,
		`read -r go_version < "$native_root/.go-version"`,
		`! "$go_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$`,
		`bootstrap_go="$(command -v go)"`, `case "$RUNNER_ARCH" in`,
		`X64) go_arch=x64 ;;`, `ARM64) go_arch=arm64 ;;`,
		`"$RUNNER_TOOL_CACHE"/go/*/"$go_arch"/bin/go`,
		`! -x "$bootstrap_go"`,
		`GOTOOLCHAIN="go$go_version" GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org `+
			`"$bootstrap_go" env GOROOT`,
		`git -C "$native_root" status --porcelain=v1 --untracked-files=all --ignored -- .`,
		`[[ -n "$native_state" ]]`,
		`GOTOOLCHAIN=local GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org `+
			`"$go_root/bin/go" -C "$native_root" mod download`,
		`git -C "$native_root" diff --exit-code -- go.mod go.sum`,
		`GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off "$go_root/bin/go" -C "$native_root" build -o "$probe_path" .`,
		`printf '%s/bin\n' "$go_root" >> "$GITHUB_PATH"`,
		`printf 'LOGBREW_TOOLCHAIN_PROBE_BIN=%s\n' "$probe_path" >> "$GITHUB_ENV"`,
	)
}
