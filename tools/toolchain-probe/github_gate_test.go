package main

import (
	"strings"
	"testing"
)

func TestGitHubSafetyNativeCallers(t *testing.T) {
	t.Parallel()
	for _, path := range []string{ciWorkflowPath, readinessWorkflowPath} {
		source := repositorySource(t, path)
		if strings.Contains(source, "python3 scripts/check_github_release_safety.py") ||
			strings.Count(source, nativeProbeInvocation+" github-release-safety --allow-public-branch-summary") != 1 {
			t.Fatal("GitHub workflow lost native checker or explicit summary policy")
		}
		steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", "contract-checks", "steps")
		built := false
		checked := false
		for _, step := range steps.Content {
			if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./tools/toolchain-probe") {
				built = yamlField(step, "if") == nil
			}
			if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check GitHub release safety") {
				checked = built && yamlField(step, "if") == nil &&
					yamlScalar(yamlField(step, "env", "GH_TOKEN"), yamlStringTag, "${{ github.token }}")
			}
		}
		if !checked {
			t.Fatal("GitHub safety gate lost bootstrap, authentication or unconditional execution")
		}
	}
	source := repositorySource(t, "scripts/check_public_sdks.sh")
	requireOrderedSource(t, source, `begin_next_step "GitHub release safety checks"`,
		`run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" github-release-safety'`,
		`begin_next_step "Markdown link checks"`)
}
