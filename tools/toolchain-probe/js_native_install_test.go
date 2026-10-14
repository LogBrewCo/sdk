package main

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestJSNativeInstallInvalidArchive(t *testing.T) {
	t.Parallel()
	destination := filepath.Join(t.TempDir(), "rejected-native-parser")
	root := openMarkdownFixture(t, map[string]string{"unverified.tar.gz": "unverified archive fixture"})
	if runJSParserInstall(nil, io.Discard, io.Discard) != exitUsage ||
		runJSParserInstall([]string{filepath.Join(root.Name(), "unverified.tar.gz"), destination},
			io.Discard, io.Discard) != exitFailure {
		t.Fatal("invalid native archive install accepted")
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("invalid archive published an installation")
	}
}

func TestJSNativeInstallOfficialArchive(t *testing.T) {
	t.Parallel()
	archive := os.Getenv("LOGBREW_TEST_OXLINT_ARCHIVE")
	if archive == "" {
		t.Skip("installation integration requires a verified archive path")
	}
	destination := filepath.Join(t.TempDir(), "verified-native-parser")
	arguments := []string{archive, destination}
	if runJSParserInstall(arguments, io.Discard, io.Discard) != exitOK ||
		!jsNativeVersion(t.Context(), filepath.Join(destination, "oxlint")) {
		t.Fatal("verified native installation failed publication or version readback")
	}
	entries, err := os.ReadDir(destination)
	if err != nil || len(entries) != 1 || entries[0].Name() != "oxlint" {
		t.Fatal("native installation inventory changed")
	}
	if runJSParserInstall(arguments, io.Discard, io.Discard) != exitFailure ||
		!jsNativeVersion(t.Context(), filepath.Join(destination, "oxlint")) {
		t.Fatal("existing native installation replaced or changed")
	}
}

func TestJSNativeInstallRejectsInvalidExecutable(t *testing.T) {
	t.Parallel()
	const member = "unusable-native-fixture"
	archive := pythonFixtureArchive(t, pythonSdist, []pythonArchiveEntry{
		pythonFixtureFile(member, "invalid executable fixture bytes"),
	})
	parent := t.TempDir()
	destination := filepath.Join(parent, "unpublished-parser")
	if jsNativeInstall(destination, archive, jsNativeFixtureIdentity(archive, member)) {
		t.Fatal("unusable executable published")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("failed executable verification left installation or staging files")
	}
}
