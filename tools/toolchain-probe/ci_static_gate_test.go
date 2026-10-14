package main

import (
	"testing"
)

func TestCIStaticNativeCallers(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, ciWorkflowPath)
	steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", "contract-checks", "steps")
	built, checked := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./tools/toolchain-probe") {
			built = yamlField(step, "if") == nil
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check CI static duplication") {
			checked = built && yamlField(step, "if") == nil &&
				yamlScalar(yamlField(step, "run"), yamlStringTag, nativeProbeInvocation+` ci-static-duplication "$PWD"`)
		}
	}
	if !checked {
		t.Fatal("CI static duplication gate lost unconditional bootstrap or verification")
	}
	source = repositorySource(t, "scripts/check_public_sdks.sh")
	requireOrderedSource(t, source,
		`run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" backend-reports "$PWD"'`,
		`run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" ci-static-duplication "$PWD"'`,
		`begin_next_step "GitHub release safety checks"`)
}
