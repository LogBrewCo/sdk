package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestJSSyntaxNativeCaller(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, "scripts/check_public_sdks.sh")
	if strings.Contains(source, "check_js_sources.py") ||
		!strings.Contains(source, `run_native_verifier js-syntax "$repo_root"`) {
		t.Fatal("repository syntax gate lost native invocation")
	}
}

func TestJSSyntaxBootstrappedRepository(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_OXLINT_DOWNLOAD") != "1" {
		t.Skip("bootstrapped syntax integration requires native download enablement")
	}
	directory, err := filepath.Abs("../..")
	root, openError := os.OpenRoot(directory)
	if err != nil || openError != nil {
		t.Fatal("repository syntax fixture unavailable")
	}
	names, valid := jsSyntaxFiles(root)
	closeError := root.Close()
	if !valid || closeError != nil || !jsSyntaxBootstrapProcess(directory, names) {
		t.Fatal("bootstrapped native repository syntax failed")
	}
}

func TestJSSyntaxBootstrapRejectsInventoryWithoutStaging(t *testing.T) {
	parent := t.TempDir()
	t.Setenv("TMPDIR", parent)
	for _, names := range [][]string{nil, make([]string, markdownFileLimit+1)} {
		if jsSyntaxBootstrapProcess(parent, names) {
			t.Fatal("invalid bootstrap inventory accepted")
		}
		entries, err := os.ReadDir(parent)
		if err != nil || len(entries) != 0 {
			t.Fatal("invalid bootstrap inventory left staging files")
		}
	}
}

func TestJSSyntaxBootstrapUnavailableTemporaryParent(t *testing.T) {
	parent := t.TempDir()
	blocked := filepath.Join(parent, "temporary-parent-file")
	if err := os.WriteFile(blocked, []byte("preserved fixture"), jsSyntaxFixtureMode); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", blocked)
	if jsSyntaxBootstrapProcess(parent, []string{"js/source.js"}) {
		t.Fatal("unavailable temporary parent accepted")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 || entries[0].Name() != filepath.Base(blocked) {
		t.Fatal("unavailable temporary parent changed existing files")
	}
}
