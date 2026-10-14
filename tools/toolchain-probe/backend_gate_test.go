package main

import (
	"strings"
	"testing"
)

func TestBackendReportNativeCallers(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, ciWorkflowPath)
	if strings.Contains(source, "check_backend_contract_reports.py") {
		t.Fatal("backend report workflow still invokes Python")
	}
	steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", "contract-checks", "steps")
	built, checked := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./tools/toolchain-probe") {
			built = yamlField(step, "if") == nil
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check backend contract reports") {
			checked = built && yamlField(step, "if") == nil &&
				yamlScalar(yamlField(step, "run"), yamlStringTag, nativeProbeInvocation+` backend-reports "$PWD"`)
		}
	}
	if !checked {
		t.Fatal("backend report gate lost unconditional bootstrap or verification")
	}
	source = repositorySource(t, "scripts/check_public_sdks.sh")
	requireOrderedSource(t, source, `begin_next_step "Backend contract report checks"`,
		`run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" backend-reports "$PWD"'`,
		`begin_next_step "GitHub release safety checks"`)
}
