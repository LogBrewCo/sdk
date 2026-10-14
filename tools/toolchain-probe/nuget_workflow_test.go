package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const (
	nugetNativeAction      = "./.release-control/tools/toolchain-probe"
	nugetDispatchCondition = "${{ github.event_name != 'release' || !contains(github.event.release.tag_name, '/') }}"
	nugetWorkflowPlanCalls = 16
)

func TestNugetPlanWorkflowCalls(t *testing.T) {
	t.Parallel()
	for _, sample := range []struct {
		filename, job string
		calls         int
	}{
		{nugetPublicationWorkflow, nugetJobName, nugetWorkflowPlanCalls},
		{pythonReconcileWorkflow, nugetJobName, 2},
		{".github/workflows/publish-release.yml", "dispatch-publish", 1},
	} {
		source := repositorySource(t, sample.filename)
		steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", sample.job, "steps")
		if steps == nil {
			t.Fatal("NuGet workflow steps unavailable")
		}
		assertNugetWorkflowSteps(t, steps, sample.job, sample.calls)
		if strings.Contains(source, "nuget_release_plan.py") {
			t.Fatal("NuGet workflow retains legacy execution")
		}
	}
}

func assertNugetWorkflowSteps(t *testing.T, steps *yaml.Node, job string, expected int) {
	t.Helper()
	controls, bootstraps, calls := 0, 0, 0
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "with", "path"), yamlStringTag, ".release-control") {
			assertNugetControlCheckout(t, step)
			controls++
		}
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, nugetNativeAction) {
			assertNugetBootstrap(t, step, job, controls)
			bootstraps++
		}
		run := yamlField(step, "run")
		if run == nil {
			continue
		}
		count := strings.Count(run.Value, nativeProbeInvocation+" nuget-plan ")
		if count > 0 && bootstraps != 1 {
			t.Fatal("NuGet plan runs without one native bootstrap")
		}
		calls += count
	}
	if controls != 1 || bootstraps != 1 || calls != expected {
		t.Fatal("NuGet workflow has missing or duplicated execution")
	}
}

func assertNugetControlCheckout(t *testing.T, step *yaml.Node) {
	t.Helper()
	inputs := yamlField(step, "with")
	sparse := yamlField(inputs, "sparse-checkout")
	if !validReconciliationCheckout(step, map[string]string{
		"ref": workflowControlRef, "repository": workflowRepository, "path": ".release-control",
	}, "sparse-checkout", "sparse-checkout-cone-mode") ||
		sparse == nil || !strings.Contains(sparse.Value, "tools/toolchain-probe/") {
		t.Fatal("NuGet control checkout does not match its source and access contract")
	}
}

func assertNugetBootstrap(t *testing.T, step *yaml.Node, job string, controls int) {
	t.Helper()
	condition := yamlField(step, "if")
	if controls != 1 || job == nugetJobName && condition != nil ||
		job != nugetJobName && !yamlScalar(condition, yamlStringTag, nugetDispatchCondition) {
		t.Fatal("NuGet verifier has incorrect ordering or execution scope")
	}
}

func TestNugetPlanStandaloneCaller(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, "scripts/real_user_dotnet_selected_public_nuget_smoke.sh")
	const calls = 4
	if strings.Contains(source, "nuget_release_plan.py") ||
		strings.Count(source, nativeProbeInvocation+" nuget-plan ") != calls {
		t.Fatal("standalone NuGet consumer does not use native plan validation and reads")
	}
	requireOrderedSource(t, source, nativeProbeInvocation+" nuget-plan validate",
		"selected=()", `if [[ -n "$artifact_root" ]]`, `dotnet new console --framework net10.0 --output "$tmp_dir/app"`)
}

func TestNugetPlanHasOneImplementation(t *testing.T) {
	t.Parallel()
	for _, filename := range []string{
		"scripts/nuget_release_plan.py", "tests/test_nuget_release_plan.py",
		"scripts/check_nuget_release_receipt_provenance.py", "tests/test_nuget_release_receipt_provenance.py",
		"scripts/check_nuget_public_artifacts.py", "tests/test_nuget_public_artifacts.py",
	} {
		if _, err := os.Lstat(filepath.Join("..", "..", filename)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("superseded NuGet checker or tests remain")
		}
	}
}

func TestNugetPublicWorkflowUsesAtomicBundle(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, pythonReconcileWorkflow)
	job := workflowJob(t, source, nugetJobName)
	requireOrderedSource(t, job,
		"- name: Build protected native NuGet verifier", nativeProbeInvocation+" nuget-plan create",
		nativeProbeInvocation+" nuget-public", "- name: Execute exact public NuGet artifacts",
		"- name: Upload NuGet reconciliation receipt")
	requireSourceText(t, job,
		`--source-commit "$RELEASE_SOURCE_SHA"`, `--source-root "$GITHUB_WORKSPACE"`,
		`--output-directory "$RUNNER_TEMP/nuget-public-artifacts"`,
		`--artifact-root "$RUNNER_TEMP/nuget-public-artifacts/packages"`,
		"path: ${{ runner.temp }}/nuget-public-artifacts/nuget-public-reconciliation.json")
	if strings.Contains(job, "check_nuget_public_artifacts.py") || strings.Contains(job, "release_metadata_dotnet") ||
		strings.Count(job, nativeProbeInvocation+" nuget-public") != 1 {
		t.Fatal("NuGet public reconciliation retains legacy or duplicate execution")
	}
}
