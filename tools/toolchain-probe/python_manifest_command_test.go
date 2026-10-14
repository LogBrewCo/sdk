package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func assertPythonManifestCommand(t *testing.T, arguments []string, expected int, scope string) {
	t.Helper()
	var output, diagnostic bytes.Buffer
	code := runPythonArchive(arguments, &output, &diagnostic)
	if code != expected {
		t.Fatalf("manifest command returned %d, expected %d: %s", code, expected, diagnostic.String())
	}
	if expected == exitOK {
		if diagnostic.Len() != 0 || output.String() != "{\"scope\":\""+scope+"\",\"valid\":true}\n" {
			t.Fatal("manifest command returned an ambiguous success receipt")
		}
	} else if output.Len() != 0 || diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), "sensitive-marker") {
		t.Fatal("manifest failure returned success or reflected private input")
	}
}

func TestPythonManifestCommands(t *testing.T) {
	t.Parallel()
	directory, _ := pythonManifestFixture(t)
	filename := filepath.Join(directory, "release-artifacts.json")
	create := append([]string{pythonManifestCreateMode, directory, filename, pythonManifestFixtureCommit},
		pythonManifestFixtureVersions()...)
	check := append([]string{pythonManifestCheckMode, filename, pythonManifestFixtureCommit},
		pythonManifestFixtureVersions()...)
	verify := []string{pythonManifestVerifyMode, directory, filename}
	assertPythonManifestCommand(t, create, exitOK, "python_release_manifest_created")
	assertPythonManifestCommand(t, check, exitOK, "python_release_manifest_identity")
	assertPythonManifestCommand(t, verify, exitOK, "python_release_manifest_verified")
	before, readable := readCheckFile(filename)
	info, err := os.Stat(filename)
	if !readable || err != nil || info.Mode().Perm() != fixtureReceiptMode {
		t.Fatal("manifest readback or private output permissions failed")
	}
	artifact := filepath.Join(directory, "logbrew_flask", "logbrew_flask-0.1.1-py3-none-any.whl")
	if err := os.Remove(artifact); err != nil {
		t.Fatal(err)
	}
	assertPythonManifestCommand(t, check, exitOK, "python_release_manifest_identity")
	assertPythonManifestCommand(t, verify, exitFailure, "")
	assertPythonManifestCommand(t, create, exitFailure, "")
	after, readable := readCheckFile(filename)
	if !readable || !bytes.Equal(before, after) {
		t.Fatal("failed manifest creation replaced the preceding receipt")
	}
}

func TestPythonManifestCommandRejectsInvalidSelection(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		{pythonManifestCreateMode},
		{pythonManifestVerifyMode},
		{pythonManifestCheckMode},
		{pythonManifestVerifyMode, "relative-directory", "/manifest.json"},
		{pythonManifestVerifyMode, "/directory", "relative-manifest"},
		{pythonManifestCreateMode, "/directory", "/manifest.json", "sensitive-marker"},
	} {
		assertPythonManifestCommand(t, arguments, exitUsage, "")
	}
	assertPythonManifestCommand(t, []string{pythonManifestVerifyMode, "/missing", "/sensitive-marker.json"},
		exitFailure, "")
}

func TestPythonManifestOutputCannotReplaceOtherFiles(t *testing.T) {
	t.Parallel()
	directory, _ := pythonManifestFixture(t)
	target := filepath.Join(t.TempDir(), "existing.json")
	marker := []byte("sensitive-marker")
	if err := os.WriteFile(target, marker, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "linked.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	arguments := append([]string{pythonManifestCreateMode, directory, link, pythonManifestFixtureCommit},
		pythonManifestFixtureVersions()...)
	assertPythonManifestCommand(t, arguments, exitFailure, "")
	actual, readable := readCheckFile(target)
	if !readable || !bytes.Equal(actual, marker) {
		t.Fatal("manifest output changed a symlink target")
	}
	arguments[2] = filepath.Join(directory, "absent", "manifest.json")
	assertPythonManifestCommand(t, arguments, exitFailure, "")
	arguments[2] = filepath.Join(directory, "logbrew_flask", "logbrew_flask-0.1.1-py3-none-any.whl")
	assertPythonManifestCommand(t, arguments, exitUsage, "")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			t.Fatal("failed manifest output leaked a temporary file")
		}
	}
}
