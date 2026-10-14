package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	pythonManifestFixtureCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	pythonManifestDirectoryMode = 0o700
	pythonManifestSymlinkCase   = "symlink-artifact"
)

type pythonManifestFixtureArtifact struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type pythonManifestFixturePackage struct {
	ID      string                        `json:"id"`
	Version string                        `json:"version"`
	Wheel   pythonManifestFixtureArtifact `json:"wheel"`
}

type pythonManifestFixtureDocument struct {
	Packages []pythonManifestFixturePackage `json:"packages"`
}

func pythonManifestFixtureVersions() []string {
	return []string{"logbrew-sdk=0.1.4", "logbrew-fastapi=0.1.4", "logbrew-flask=0.1.1", "logbrew-django=0.1.1"}
}

func pythonFixtureManifest(tb testing.TB, directory string, selection pythonReleaseSelection) map[string]any {
	tb.Helper()
	document, valid := createPythonReleaseManifest(directory, selection)
	if !valid {
		tb.Fatal("fixture manifest failed")
	}
	return document
}

func pythonManifestFixture(tb testing.TB) (string, pythonReleaseSelection) {
	tb.Helper()
	directory := tb.TempDir()
	selection, valid := pythonReleaseVersions(pythonManifestFixtureCommit, pythonManifestFixtureVersions())
	if !valid {
		tb.Fatal("valid package selection rejected")
	}
	for _, spec := range pythonReleaseCatalog() {
		version := selection.versions[spec.id]
		packageDirectory := filepath.Join(directory, spec.directory)
		if err := os.Mkdir(packageDirectory, pythonManifestDirectoryMode); err != nil {
			tb.Fatal(err)
		}
		for _, kind := range []string{pythonWheel, pythonSdist} {
			root := pythonArtifactRoot(spec.id, version)
			name := root + "/PKG-INFO"
			if kind == pythonWheel {
				name = root + ".dist-info/METADATA"
			}
			metadata := fmt.Sprintf("Metadata-Version: 2.4\nName: %s\nVersion: %s\n", spec.id, version)
			data := pythonFixtureArchive(tb, kind, []pythonArchiveEntry{pythonFixtureFile(name, metadata)})
			file := filepath.Join(directory, pythonReleaseArtifactPath(spec, version, kind))
			if err := os.WriteFile(file, data, fixtureReceiptMode); err != nil {
				tb.Fatal(err)
			}
		}
	}
	return directory, selection
}

func TestPythonManifestBindsAllArtifacts(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	manifest, valid := createPythonReleaseManifest(directory, selection)
	if !valid {
		t.Fatal("complete package set rejected")
	}
	data, err := json.Marshal(manifest)
	if err != nil || !verifyPythonReleaseManifest(directory, data) || !checkPythonReleaseManifest(data, selection) {
		t.Fatal("created manifest did not verify its exact files and identity")
	}
	var document pythonManifestFixtureDocument
	if err := json.Unmarshal(data, &document); err != nil || len(document.Packages) != 4 {
		t.Fatal("manifest did not include all four packages")
	}
	flask := document.Packages[2]
	if flask.ID != "logbrew-flask" || flask.Version != "0.1.1" ||
		flask.Wheel.File != "logbrew_flask/logbrew_flask-0.1.1-py3-none-any.whl" || len(flask.Wheel.SHA256) != 64 {
		t.Fatal("manifest changed the established package order or artifact naming")
	}
	selection.sourceCommit = strings.Repeat("b", pythonSourceCommitSize)
	if checkPythonReleaseManifest(data, selection) {
		t.Fatal("manifest accepted another source commit")
	}
}

func TestPythonManifestRejectsChangedArtifactSet(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{
		"missing-artifact", "extra-artifact", "changed", "metadata-mismatch", pythonManifestSymlinkCase,
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			directory, selection := pythonManifestFixture(t)
			data := pythonManifestJSON(t, pythonFixtureManifest(t, directory, selection))
			file := filepath.Join(directory, "logbrew_flask", "logbrew_flask-0.1.1-py3-none-any.whl")
			mutatePythonReleaseFixture(t, mutation, directory, file)
			if verifyPythonReleaseManifest(directory, data) {
				t.Fatal("changed artifact set verified against the old manifest")
			}
		})
	}
}

func mutatePythonReleaseFixture(t *testing.T, mutation, directory, file string) {
	t.Helper()
	switch mutation {
	case "missing-artifact":
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
	case pythonManifestSymlinkCase:
		target := filepath.Join(t.TempDir(), "outside.whl")
		if err := os.Rename(file, target); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, file); err != nil {
			t.Fatal(err)
		}
	case "extra-artifact":
		file = filepath.Join(directory, "logbrew_flask", "unexpected.whl")
		fallthrough
	case "changed":
		if err := os.WriteFile(file, []byte("changed"), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	case "metadata-mismatch":
		metadata := "Metadata-Version: 2.4\nName: logbrew-flask\nVersion: 9.9.9\n"
		entry := pythonFixtureFile("logbrew_flask-0.1.1.dist-info/METADATA", metadata)
		if err := os.WriteFile(file, pythonFixtureZip(t, []pythonArchiveEntry{entry}), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("unknown artifact mutation")
	}
}

func TestPythonReleaseSelectionIsExact(t *testing.T) {
	t.Parallel()
	versions := pythonManifestFixtureVersions()
	for _, selection := range [][]string{
		nil, versions[:3], append(append([]string(nil), versions...), versions[0]),
		{versions[0], versions[0], versions[2], versions[3]},
		{"unknown=0.1.4", versions[1], versions[2], versions[3]},
		{"logbrew-sdk=../other", versions[1], versions[2], versions[3]},
	} {
		if _, valid := pythonReleaseVersions(pythonManifestFixtureCommit, selection); valid {
			t.Error("accepted incomplete, repeated, or invalid versions")
		}
	}
	for _, commit := range []string{
		"", strings.Repeat("A", pythonSourceCommitSize), strings.Repeat("a", pythonSourceCommitSize-1), "../source",
	} {
		if _, valid := pythonReleaseVersions(commit, versions); valid {
			t.Error("accepted invalid source commit")
		}
	}
}
