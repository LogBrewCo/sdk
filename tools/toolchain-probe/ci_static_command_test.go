package main

import (
	"io"
	"strings"
	"testing"
)

func TestCIStaticCommand(t *testing.T) {
	t.Parallel()
	for _, document := range []string{"run: go test ./...", "run: shellcheck file.sh"} {
		root := openMarkdownFixture(t, map[string]string{ciWorkflowDirectory + "/ci.yml": document})
		var output strings.Builder
		code := runCIStaticDuplication([]string{root.Name()}, &output, io.Discard)
		if (code == exitOK) != !ciStaticCommandPresent(document) ||
			!strings.Contains(output.String(), `"complete":true`) {
			t.Fatal("CI static command lost classification or completion state")
		}
	}
	if runCIStaticDuplication(nil, io.Discard, io.Discard) != exitUsage {
		t.Fatal("CI static command accepted missing root")
	}
	if writeCIStaticReceipt(io.Discard, ciStaticInventory{findings: nil, complete: false}) != exitFailure ||
		writeCIStaticReceipt(rejectedCheckOutput{}, ciStaticInventory{findings: nil, complete: true}) != exitFailure {
		t.Fatal("incomplete scan or failed CI receipt write passed")
	}
}
