package main

import (
	"strings"
	"testing"
)

func TestGeneratedGateUsesNativeChecker(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, "scripts/check_public_sdks.sh")
	if strings.Contains(source, "check_generated_artifacts.py") {
		t.Fatal("artifact gate still invokes Python")
	}
	const gate = `begin_next_step "Generated artifact hygiene"
cleanup_build_artifacts
run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" generated-artifacts "$PWD"'
mark_step_complete`
	if !strings.Contains(source, gate) {
		t.Fatal("artifact gate lost required verification sequence")
	}
}
