package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestBrandGeneratedCommandRepository(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("generation command integration requires explicit native renderer enablement")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if runBrandGenerated([]string{root}, &output, io.Discard) != exitOK ||
		output.String() != brandSuccessJSON() {
		t.Fatal("actual generation command failed")
	}
	if runBrandGenerated([]string{root}, rejectedCheckOutput{}, io.Discard) != exitFailure {
		t.Fatal("generation output failure passed")
	}
}

func TestBrandGeneratedCommandInputs(t *testing.T) {
	t.Parallel()
	if runBrandGenerated(nil, io.Discard, io.Discard) != exitUsage {
		t.Fatal("missing generated command root accepted")
	}
	var output bytes.Buffer
	if runBrandGenerated([]string{t.TempDir()}, &output, io.Discard) != exitFailure ||
		output.String() != "{\"passed\":false}\n" {
		t.Fatal("incomplete generation claimed success")
	}
}
