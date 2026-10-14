package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func pythonMetadataFixture(t *testing.T) string {
	t.Helper()
	files := make(map[string]string)
	for _, spec := range pythonReleaseCatalog() {
		prefix := "python/" + spec.directory + "/"
		files[prefix+"pyproject.toml"] = repositorySource(t, prefix+"pyproject.toml")
		module := strings.ReplaceAll(spec.id, "-", "_")
		for _, name := range []string{
			policyRootGuide, "src/" + module + "/py.typed", "src/" + module + "/examples/__main__.py",
		} {
			files[prefix+name] = ""
		}
	}
	return confidentialityFixture(t, files)
}

func runPythonMetadata(arguments []string, output, diagnostic io.Writer) int {
	return runReleaseMetadata(append([]string{pythonMetadataDirectory}, arguments...), output, diagnostic)
}

func TestPythonMetadataCommand(t *testing.T) {
	t.Parallel()
	root := pythonMetadataFixture(t)
	var output, diagnostic bytes.Buffer
	if runPythonMetadata([]string{root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"python_release_metadata\",\"valid\":true}\n" {
		t.Fatal("complete metadata did not produce the exact success receipt")
	}
	for _, arguments := range [][]string{nil, {"relative-repository"}, {root, root}} {
		output.Reset()
		diagnostic.Reset()
		if runPythonMetadata(arguments, &output, &diagnostic) != exitUsage || output.Len() != 0 ||
			diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), root) {
			t.Fatal("invalid input succeeded or leaked an input path")
		}
	}
	assertPythonMetadataFailure(t, filepath.Join(root, "missing"))
	for _, writer := range []io.Writer{shortCheckOutput{}, rejectedCheckOutput{}} {
		if runPythonMetadata([]string{root}, writer, &diagnostic) != exitFailure ||
			runPythonMetadata(nil, &output, writer) != exitFailure {
			t.Fatal("output failure did not fail the command")
		}
	}
}

func assertPythonMetadataFailure(t *testing.T, root string) {
	t.Helper()
	var output, diagnostic bytes.Buffer
	if runPythonMetadata([]string{root}, &output, &diagnostic) != exitFailure || output.Len() != 0 ||
		diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), root) {
		t.Fatal("invalid repository succeeded, omitted its diagnostic, or leaked an input path")
	}
}

func TestPythonMetadataCommandRejectsIncompletePackages(t *testing.T) {
	t.Parallel()
	for _, name := range []string{
		pythonMetadataManifest, policyRootGuide, "src/logbrew_flask/py.typed", "src/logbrew_flask/examples/__main__.py",
	} {
		root := pythonMetadataFixture(t)
		if err := os.Remove(filepath.Join(root, pythonMetadataDirectory, "logbrew_flask", name)); err != nil {
			t.Fatal(err)
		}
		assertPythonMetadataFailure(t, root)
	}
}

func TestPythonMetadataCommandRejectsUnexpectedPackage(t *testing.T) {
	t.Parallel()
	root := pythonMetadataFixture(t)
	packagePath := filepath.Join(root, pythonMetadataDirectory, "logbrew_unexpected")
	if err := os.Mkdir(packagePath, gitFixtureDirectoryMode); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(packagePath, pythonMetadataManifest)
	if err := os.WriteFile(manifest, []byte("[project]\n"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	assertPythonMetadataFailure(t, root)
}

func TestPythonMetadataCommandBounds(t *testing.T) {
	t.Parallel()
	root := pythonMetadataFixture(t)
	for index := len(pythonReleaseCatalog()); index < pythonMetadataEntryLimit; index++ {
		path := filepath.Join(root, pythonMetadataDirectory, strconv.Itoa(index))
		if err := os.Mkdir(path, gitFixtureDirectoryMode); err != nil {
			t.Fatal(err)
		}
	}
	if runPythonMetadata([]string{root}, io.Discard, io.Discard) != exitOK {
		t.Fatal("bounded inventory rejected")
	}
	extra := filepath.Join(root, pythonMetadataDirectory, "over-limit")
	if err := os.Mkdir(extra, gitFixtureDirectoryMode); err != nil {
		t.Fatal(err)
	}
	assertPythonMetadataFailure(t, root)
}

func TestPythonMetadataCommandRejectsMalformedManifest(t *testing.T) {
	t.Parallel()
	for _, data := range []string{"", "[project", strings.Repeat(" ", pythonManifestLimit+1)} {
		root := pythonMetadataFixture(t)
		manifest := filepath.Join(root, pythonMetadataDirectory, "logbrew_flask", pythonMetadataManifest)
		if err := os.WriteFile(manifest, []byte(data), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		assertPythonMetadataFailure(t, root)
	}
}
