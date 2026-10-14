package main

import (
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestMarkdownFailureLineAndReason(t *testing.T) {
	t.Parallel()
	for _, separator := range []string{"\n", "\r\n", "\u2028"} {
		root := confidentialityFixture(t, map[string]string{
			policyRootGuide: "# Start" + separator + separator + "[missing](unavailable.md)",
		})
		var diagnostic strings.Builder
		if runMarkdownLinks([]string{root}, io.Discard, &diagnostic) != exitFailure {
			t.Fatal("missing Markdown target accepted")
		}
		var failure struct {
			Source string `json:"source"`
			Reason string `json:"reason"`
			Line   int    `json:"line"`
		}
		if err := json.Unmarshal([]byte(diagnostic.String()), &failure); err != nil {
			t.Fatal(err)
		}
		const expectedLine = 3
		if failure.Source != policyRootGuide || failure.Reason != "target-unavailable" || failure.Line != expectedLine {
			t.Fatalf("wrong Markdown diagnostic: %s", diagnostic.String())
		}
		if strings.Contains(diagnostic.String(), root) || strings.Contains(diagnostic.String(), "unavailable.md") {
			t.Fatal("Markdown diagnostic reflected a root or target path")
		}
	}
}

func TestMarkdownFailureOutput(t *testing.T) {
	t.Parallel()
	failure := markdownFailure{source: policyRootGuide, reason: "anchor-missing", line: 1}
	if writeMarkdownFailure(rejectedCheckOutput{}, failure) != exitFailure {
		t.Fatal("Markdown failure output changed exit code")
	}
}
