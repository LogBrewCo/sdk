package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestGeneratedArtifactsPassCleanTree(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	writeTreeFile(t, root, ".git/objects/__pycache__/kept.pyc")
	writeTreeFile(t, root, "dotnet/other/bin/kept")
	var output, diagnostic bytes.Buffer
	if code := checkGeneratedArtifacts([]string{root}, &output, &diagnostic); code != exitOK ||
		output.String() != "generated artifact hygiene ok\n" {
		t.Fatalf("code %d: %q", code, diagnostic.String())
	}
}

func TestGeneratedArtifactsReportExactAndPatternPaths(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	for _, name := range []string{
		"Cargo.lock", "php/logbrew-php/vendor/autoload.php", "js/logbrew-js/examples/pnpm-lock.yaml",
		"python/logbrew_py/tests/__pycache__/x.pyc", "dotnet/logbrew-dotnet/src/LogBrew/bin/LogBrew.dll",
		"dotnet/logbrew-dotnet/bin/direct", "objc/logbrew-objc/src/LogBrew.o",
	} {
		writeTreeFile(t, root, name)
	}
	var output, diagnostic bytes.Buffer
	if code := checkGeneratedArtifacts([]string{root}, &output, &diagnostic); code != exitFailure {
		t.Fatalf("code %d", code)
	}
	want := "generated artifact hygiene failed:\n" + strings.Join([]string{
		"Cargo.lock", "dotnet/logbrew-dotnet/bin", "dotnet/logbrew-dotnet/src/LogBrew/bin",
		"js/logbrew-js/examples/pnpm-lock.yaml", "objc/logbrew-objc/src/LogBrew.o", "php/logbrew-php/vendor",
		"python/logbrew_py/tests/__pycache__", "python/logbrew_py/tests/__pycache__/x.pyc",
	}, "\n") + "\n"
	got := strings.ReplaceAll(diagnostic.String(), "- generated artifact remains: ", "")
	if !strings.HasPrefix(got, want) || !strings.HasSuffix(got, "reporting a clean cycle\n") {
		t.Fatalf("report %q", got)
	}
	if code := checkGeneratedArtifacts(nil, &output, &diagnostic); code != exitUsage {
		t.Fatalf("usage code %d", code)
	}
}

func writeTreeFile(t *testing.T, root, name string) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
}
