package main

import (
	"io"
	"strings"
	"testing"
)

func TestMarkdownCommand(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{policyRootGuide: "# Start\n[self](#start)"})
	for _, arguments := range [][]string{nil, {"./docs"}, {root, root}} {
		if runMarkdownLinks(arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid Markdown command arguments accepted")
		}
	}
	var output strings.Builder
	if runMarkdownLinks([]string{root}, &output, io.Discard) != exitOK || output.String() != "markdown links ok\n" {
		t.Fatal("valid Markdown command failed")
	}
	for _, writer := range []io.Writer{rejectedCheckOutput{}, shortCheckOutput{}} {
		if runMarkdownLinks([]string{root}, writer, io.Discard) != exitFailure {
			t.Fatal("Markdown command accepted output failure")
		}
	}
}

func TestMarkdownByteBudget(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{policyRootGuide: "# Start"})
	check := markdownCheck{
		anchors: make(map[string]map[string]bool), root: root,
		failure: markdownFailure{source: "", reason: "", line: 0}, remaining: 1,
	}
	if check.document(policyRootGuide) {
		t.Fatal("Markdown document exceeded byte budget")
	}
}
