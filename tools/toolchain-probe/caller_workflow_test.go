package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackageJobsBuildNativeVerifier(t *testing.T) {
	t.Parallel()
	for _, item := range []struct {
		workflow string
		jobs     string
	}{
		{ciWorkflowPath, "swift-checks objc-checks kotlin-checks"},
		{
			readinessWorkflowPath,
			"node python rust go c cpp objc java dotnet unity kotlin ruby php swift",
		},
	} {
		workflow := repositorySource(t, item.workflow)
		for name := range strings.FieldsSeq(item.jobs) {
			if item.workflow != ciWorkflowPath {
				name += "-dry-run"
			}
			job := workflowJob(t, workflow, name)
			bootstrap := "uses: ./tools/toolchain-probe"
			requireOrderedSource(t, job, bootstrap, "run:")
			if name == "go-dry-run" {
				requireOrderedSource(t, job, bootstrap, "Set up Go")
			}
		}
	}
}

func TestNativeConfidentialityCallers(t *testing.T) {
	t.Parallel()
	const invocation = nativeProbeInvocation + " confidentiality-check"
	for _, name := range []string{ciWorkflowPath, readinessWorkflowPath} {
		job := workflowJob(t, repositorySource(t, name), "contract-checks")
		requireOrderedSource(t, job, "uses: ./tools/toolchain-probe", invocation)
		if strings.Count(job, invocation) != 1 {
			t.Errorf("%s must invoke the bootstrapped native check exactly once", name)
		}
	}
	aggregate := repositorySource(t, "scripts/check_public_sdks.sh")
	if strings.Count(aggregate, "run_shell_step '"+invocation+"'") != 1 {
		t.Error("the local aggregate does not use the canonical native command")
	}
	for _, name := range []string{
		"scripts/check_confidentiality_scan.py", "tests/test_confidentiality_scan.py",
		"tests/test_dotnet_confidentiality_scan.py", "tests/test_go_confidentiality_scan.py",
	} {
		if _, err := os.Lstat(filepath.Join("..", "..", name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("superseded Python check still exists: %s", name)
		}
	}
	for name, modules := range unitPathTargets() {
		if strings.Contains(name, "confidentiality_scan") || strings.Contains(modules, "confidentiality_scan") {
			t.Error("unit selection retains the superseded checker")
		}
	}
}
