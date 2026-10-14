package main

import (
	"io"
	"strings"
	"testing"
)

func TestGeneratedArtifactCommand(t *testing.T) {
	t.Parallel()
	for _, files := range []map[string]string{
		{"docs/artifact-check.md": "# Public guide"},
		{generatedCargoLock: "generated"},
	} {
		root := confidentialityFixture(t, files)
		var output strings.Builder
		code := runGeneratedArtifacts([]string{root}, &output, io.Discard)
		_, dirty := files[generatedCargoLock]
		if (code == exitOK) == dirty || !strings.Contains(output.String(), `"complete":true`) {
			t.Fatal("generated artifact command confused clean and dirty trees")
		}
	}
	for _, arguments := range [][]string{nil, {"relative-root"}, {"/tmp", "unexpected-argument"}} {
		if runGeneratedArtifacts(arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid generated artifact command accepted")
		}
	}
}

func TestGeneratedArtifactReceiptFailure(t *testing.T) {
	t.Parallel()
	incomplete := generatedInventory{paths: nil, complete: false}
	if writeGeneratedArtifacts(io.Discard, incomplete) != exitFailure {
		t.Fatal("incomplete inventory passed")
	}
	clean := generatedInventory{paths: nil, complete: true}
	if writeGeneratedArtifacts(rejectedCheckOutput{}, clean) != exitFailure {
		t.Fatal("failed artifact receipt write passed")
	}
}
