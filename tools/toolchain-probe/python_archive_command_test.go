package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const missingPythonArtifact = "/missing"

func TestPythonArchiveCommand(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{pythonWheel, pythonSdist} {
		metadataName := pythonFixtureWheelMetadata
		suffix := "-py3-none-any.whl"
		if kind == pythonSdist {
			metadataName, suffix = pythonFixtureRoot+"/PKG-INFO", ".tar.gz"
		}
		entries := []pythonArchiveEntry{pythonFixtureFile(metadataName, pythonFixtureMetadata)}
		data := pythonFixtureArchive(t, kind, entries)
		filename := filepath.Join(t.TempDir(), pythonFixtureRoot+suffix)
		if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		arguments := []string{kind, filename, pythonFixturePackage, pythonFixtureVersion}
		var output, diagnostic bytes.Buffer
		if code := runPythonArchive(arguments, &output, &diagnostic); code != exitOK || diagnostic.Len() != 0 {
			t.Fatalf("%s archive proof failed: code=%d diagnostic=%q", kind, code, diagnostic.String())
		}
		assertPythonArchiveReceipt(t, output.Bytes())
		if err := os.WriteFile(filename, []byte("sensitive-marker"), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		output.Reset()
		diagnostic.Reset()
		if code := runPythonArchive(arguments, &output, &diagnostic); code != exitFailure ||
			output.Len() != 0 || strings.Contains(diagnostic.String(), "sensitive-marker") {
			t.Fatal("invalid archive leaked input or emitted success")
		}
	}
}

func assertPythonArchiveReceipt(t *testing.T, data []byte) {
	t.Helper()
	var receipt pythonArchiveReceipt
	if err := json.Unmarshal(data, &receipt); err != nil ||
		!receipt.Valid || receipt.Scope != "python_archive_identity" || receipt.Files != 1 ||
		len(receipt.SHA256) != 64 || len(receipt.ContentSHA256) != 64 {
		t.Fatal("archive identity receipt is incomplete")
	}
}

func TestPythonArchiveCommandRejectsInvalidSelection(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		nil,
		{pythonWheel},
		{"zip", missingPythonArtifact, pythonFixturePackage, pythonFixtureVersion},
		{pythonWheel, "relative", pythonFixturePackage, pythonFixtureVersion},
		{pythonWheel, missingPythonArtifact, "unknown", pythonFixtureVersion},
		{pythonWheel, missingPythonArtifact, pythonFixturePackage, "../other"},
	} {
		var output, diagnostic bytes.Buffer
		if code := runPythonArchive(arguments, &output, &diagnostic); code != exitUsage || output.Len() != 0 {
			t.Fatal("invalid artifact selection did not fail before reading")
		}
	}
}
