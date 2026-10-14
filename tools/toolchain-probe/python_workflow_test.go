package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	pythonReconcileWorkflow  = ".github/workflows/reconcile-public-packages.yml"
	pythonReleaseJob         = "pypi"
	pythonLegacySmoke        = "scripts/real_user_python_public_pypi_smoke.sh"
	pythonConsumerInvocation = nativeProbeInvocation + " " + pythonSmokeMode
)

func TestPythonPublicConsumerUsesNativeArtifactVerification(t *testing.T) {
	t.Parallel()
	for _, filename := range []string{publicationWorkflow, pythonReconcileWorkflow} {
		job := workflowJob(t, repositorySource(t, filename), pythonReleaseJob)
		count := 1
		if filename == publicationWorkflow {
			count = 2
		}
		if strings.Contains(job, pythonLegacySmoke) ||
			strings.Count(job, pythonConsumerInvocation) != count {
			t.Fatal("Python artifact execution must use the protected native verifier in every phase")
		}
	}
	for _, filename := range []string{pythonLegacySmoke, "tests/test_python_public_pypi_smoke.py"} {
		if _, err := os.Lstat(filepath.Join("..", "..", filename)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("superseded Python public-consumer implementation or static test remains")
		}
	}
}

func TestPythonAggregateUsesNativeConsumer(t *testing.T) {
	t.Parallel()
	body := repositorySource(t, "scripts/check_public_sdks.sh")
	requireSourceText(t, body,
		`begin_next_step "Python public PyPI install smoke"`+"\nrun_shell_step '"+
			pythonConsumerInvocation+"'\nmark_step_complete",
	)
	if strings.Contains(body, pythonLegacySmoke) {
		t.Fatal("aggregate checks still call the retired Python consumer")
	}
	requireOrderedSource(t, body,
		`begin_next_step "Python Celery real-user smoke"`, `begin_next_step "FastAPI real-user smoke"`,
		`begin_next_step "Django real-user smoke"`, `begin_next_step "Python public PyPI install smoke"`,
		`begin_next_step "Go real-user smoke"`,
	)
	for _, module := range selectUnitTargets([]string{pythonReconcileWorkflow}) {
		if module == "tests.test_python_public_pypi_smoke" {
			t.Fatal("unit selection schedules a retired Python test")
		}
	}
}

func TestPythonLegacyConsumerExceptionIsAbsent(t *testing.T) {
	t.Parallel()
	line := policyFixtureLine(`if parsed.scheme != "https" or parsed.{host} != "files.pythonhosted.org":`)
	if newConfidentialityPolicy().allowed(pythonLegacySmoke, line) {
		t.Fatal("retired public-consumer path still has a confidentiality exception")
	}
}

func TestPythonReleaseUsesNativeArtifactCommands(t *testing.T) {
	t.Parallel()
	for _, filename := range []string{publicationWorkflow, pythonReconcileWorkflow} {
		job := workflowJob(t, repositorySource(t, filename), pythonReleaseJob)
		requireSourceText(t, job,
			"uses: ./.release-control/tools/toolchain-probe", "tools/toolchain-probe/",
			nativeProbeInvocation+" python-archive create-manifest",
			nativeProbeInvocation+" python-archive normalize-sdist",
			nativeProbeInvocation+" python-archive resolve-public",
			`"$RUNNER_TEMP/python-public-artifacts/release-artifacts.json"`,
			"${{ runner.temp }}/python-public-artifacts/public-reconciliation.json",
			"${{ runner.temp }}/python-public-artifacts/release-artifacts.json",
			`--artifact-root "$RUNNER_TEMP/python-public-artifacts"`,
		)
		for _, old := range []string{
			"check_python_release_artifacts.py", "python-public-release-artifacts.json",
			`"$RUNNER_TEMP/python-public-reconciliation.json"`,
		} {
			if strings.Contains(job, old) {
				t.Errorf("%s still uses the old Python artifact contract", filename)
			}
		}
	}
}

func TestPythonPublicationPreservesArtifactProofOrder(t *testing.T) {
	t.Parallel()
	job := workflowJob(t, repositorySource(t, publicationWorkflow), pythonReleaseJob)
	requireSourceText(t, job,
		`"$GITHUB_WORKSPACE/dist/pypi"`, `"$GITHUB_WORKSPACE/dist/pypi/python-release-artifacts.json"`,
		`"$(git rev-parse HEAD)"`, "logbrew-flask=${{ steps.pypi-version.outputs.flask_version }}",
		nativeProbeInvocation+" python-archive verify-manifest", pythonConsumerInvocation+" --manifest",
		"Upload Python release manifest", "name: python-public-reconciliation", "--artifact-root dist/pypi",
	)
	requireOrderedSource(t, job,
		"- name: Build protected native verifier", "- name: Build Python distributions",
		"- name: Create Python release manifest", "- name: Verify reproducible Python distributions",
		"- name: Verify packed Python distributions", "- name: Publish logbrew-sdk to PyPI",
		"- name: Verify public PyPI packages", "- name: Resolve public PyPI artifacts",
		"- name: Upload Python public reconciliation", "- name: Verify public PyPI installs",
	)
}

func TestPythonReleasePreservesReproducibleBuildInputs(t *testing.T) {
	t.Parallel()
	requireSourceText(t, repositorySource(t, "scripts/python_release_tools.txt"),
		"build==1.5.0", "pip==26.2.1", "setuptools==83.0.0", "twine==7.0.0", "uv==0.12.9", "wheel==0.47.0",
	)
	for _, filename := range []string{publicationWorkflow, pythonReconcileWorkflow} {
		job := workflowJob(t, repositorySource(t, filename), pythonReleaseJob)
		requireSourceText(t, job,
			"scripts/python_release_tools.txt", "SOURCE_DATE_EPOCH", "PYTHONHASHSEED=0", "TZ=UTC",
			"--no-isolation", "normalize-sdist", `"$SOURCE_DATE_EPOCH"`, "git show -s --format=%ct HEAD",
		)
	}
	requireSourceText(t, repositorySource(t, publicationWorkflow), "$RUNNER_TEMP/python-reproducibility")
}

func TestPublicReconciliationStaysSourceBoundAndCannotPublish(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, pythonReconcileWorkflow)
	requireSourceText(t, workflow,
		"workflow_dispatch:", "actions: read", "contents: read", "ref: ${{ inputs.ref }}",
		"ref: ${{ github.workflow_sha }}", "CONTROL_REF: ${{ github.ref }}", "path: .release-control",
		`[[ "$CONTROL_REF" != "refs/heads/main"`,
		"persist-credentials: false", nativeProbeInvocation+" publication-run",
		"RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}",
		"RELEASE_SOURCE_SHA: ${{ steps.release-source.outputs.sha }}",
		`git -C "$control_root" rev-parse --verify 'HEAD^{commit}'`,
		nativeProbeInvocation+" nuget-public", "uses: ./.release-control/tools/toolchain-probe",
		`--source-root "$GITHUB_WORKSPACE"`, pythonConsumerInvocation,
		"real_user_dotnet_selected_public_nuget_smoke.sh", "nuget-public-reconciliation.json",
		`"$RUNNER_TEMP/python-public-smoke.out"`, `"Python public artifact execution failed."`,
	)
	for _, forbidden := range []string{
		"id-token: write", "environment: release", "gh-action-pypi-publish", "dotnet nuget push", "nuget/login",
	} {
		if strings.Contains(workflow, forbidden) {
			t.Error("reconciliation gained a publication capability")
		}
	}
	job := workflowJob(t, workflow, pythonReleaseJob)
	requireOrderedSource(t, job,
		"- name: Bind protected release control", "- name: Build protected native verifier",
		"- name: Authenticate PyPI publication boundary", "- name: Validate authenticated Python release manifest",
		"- name: Build exact-source Python distributions", "- name: Bind exact-source Python distributions",
		"- name: Reconcile public Python artifacts", "- name: Execute exact public Python artifacts",
	)
	requireSourceText(t, job, nativeProbeInvocation+" python-archive check-manifest")
}

func requireOrderedSource(t *testing.T, workflow string, names ...string) {
	t.Helper()
	previous := -1
	for _, name := range names {
		index := strings.Index(workflow, name)
		if index <= previous {
			t.Fatalf("missing or reordered source: %s", name)
		}
		previous = index
	}
}
