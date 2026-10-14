package main

import (
	"strings"
	"testing"
)

func TestMarkdownGateUsesNativeChecker(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, "scripts/check_public_sdks.sh")
	if strings.Contains(source, "check_markdown_links.py") {
		t.Fatal("Markdown gate still invokes Python")
	}
	requireOrderedSource(t, source, `begin_next_step "Markdown link checks"`,
		`run_shell_step '"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}" markdown-links "$PWD"'`,
		`begin_next_step "Shell static analysis"`)
}
