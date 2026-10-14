package main

import (
	"bytes"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPythonPublicCommandRejectsInvalidInputsBeforeNetwork(t *testing.T) {
	t.Parallel()
	directory := t.TempDir()
	manifest := filepath.Join(directory, "manifest.json")
	if err := os.WriteFile(manifest, []byte("null"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		arguments []string
		code      int
	}{
		{[]string{pythonPublicVerifyMode}, exitUsage},
		{[]string{pythonPublicVerifyMode, "nonabsolute-public-input", manifest}, exitUsage},
		{[]string{pythonPublicVerifyMode, directory, manifest}, exitFailure},
		{[]string{pythonPublicVerifyMode, directory, filepath.Join(directory, "missing.json")}, exitFailure},
		{[]string{pythonPublicResolveMode, directory, manifest}, exitUsage},
		{[]string{pythonPublicResolveMode, directory, manifest, "nonabsolute-bundle-output"}, exitUsage},
		{[]string{pythonPublicResolveMode, directory, manifest, filepath.Join(directory, "public")}, exitFailure},
	} {
		var output, diagnostic bytes.Buffer
		if code := runPythonArchive(test.arguments, &output, &diagnostic); code != test.code || output.Len() != 0 ||
			diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), directory) {
			t.Fatal("public verification exposed an input path or misreported failure")
		}
	}
}

func FuzzPythonPublicMetadata(f *testing.F) {
	f.Add(pythonPublicFixture(f))
	f.Add([]byte("null"))
	f.Fuzz(func(t *testing.T, data []byte) {
		spec := pythonReleaseCatalog()[0]
		first, valid := parsePythonPublicMetadata(data, spec, pythonPublicFixtureVersion)
		second, repeated := parsePythonPublicMetadata(data, spec, pythonPublicFixtureVersion)
		if valid != repeated || !maps.Equal(first, second) || valid && len(first) != pythonReleaseFileCount {
			t.Fatal("registry metadata result is not deterministic or complete")
		}
	})
}
