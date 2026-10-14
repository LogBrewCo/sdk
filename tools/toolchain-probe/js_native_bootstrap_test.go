package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestJSNativeBootstrapArguments(t *testing.T) {
	t.Parallel()
	if runJSParserBootstrap(nil, io.Discard, io.Discard) != exitUsage ||
		runJSParserBootstrap([]string{"relative-native-output"}, io.Discard, io.Discard) != exitUsage {
		t.Fatal("bootstrap accepted invalid destination arguments")
	}
	if runJSParserBootstrap([]string{t.TempDir()}, io.Discard, io.Discard) != exitFailure {
		t.Fatal("bootstrap accepted an existing directory")
	}
}

func TestJSNativeBootstrapOfficialRelease(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_OXLINT_DOWNLOAD") != "1" {
		t.Skip("bootstrap integration requires explicit native release download enablement")
	}
	destination := filepath.Join(t.TempDir(), "downloaded-native-parser")
	if runJSParserBootstrap([]string{destination}, io.Discard, io.Discard) != exitOK ||
		!jsNativeVersion(t.Context(), filepath.Join(destination, "oxlint")) {
		t.Fatal("official native bootstrap or version readback failed")
	}
}
