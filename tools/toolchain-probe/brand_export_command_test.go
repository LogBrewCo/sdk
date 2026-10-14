package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestBrandExportRepository(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("export integration requires native renderer enablement")
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "native-brand-export")
	var output bytes.Buffer
	arguments := []string{root, destination}
	if runBrandExport(arguments, &output, io.Discard) != exitOK || output.String() != brandSuccessJSON() {
		t.Fatal("native brand export failed")
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != len(brandGeneratedAssets()) {
		t.Fatal("native export output inventory incomplete")
	}
	if runBrandExport(arguments, io.Discard, io.Discard) != exitFailure {
		t.Fatal("native export replaced existing output")
	}
}

func TestBrandExportInvalidInputs(t *testing.T) {
	t.Parallel()
	if runBrandExport(nil, io.Discard, io.Discard) != exitUsage {
		t.Fatal("export accepted missing paths")
	}
	destination := filepath.Join(t.TempDir(), "exported-assets")
	var output bytes.Buffer
	if runBrandExport([]string{t.TempDir(), destination}, &output, io.Discard) != exitFailure {
		t.Fatal("incomplete repository exported")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("failed export published output")
	}
}
