package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type pythonInstalledFixture struct {
	site, wheel string
}

const (
	pythonInstalledFixtureLink    = "module-link"
	pythonInstalledFixtureModule  = "logbrew_flask"
	pythonInstalledFixtureMissing = "missing-module"
)

func pythonInstallFixture(t *testing.T) pythonInstalledFixture {
	t.Helper()
	site := t.TempDir()
	metadata := pythonFixtureRoot + ".dist-info/"
	entries := []pythonArchiveEntry{
		pythonFixtureFile(pythonFixtureWheelMetadata, pythonFixtureMetadata),
		pythonFixtureFile(metadata+"WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\n"),
		pythonFixtureFile(metadata+"RECORD", "archive-owned record"),
		pythonFixtureFile("logbrew_flask/__init__.py", ""),
		pythonFixtureFile("logbrew_flask/examples/__main__.py", "print('example')\n"),
	}
	for _, entry := range entries {
		name := filepath.Join(site, entry.name)
		if err := os.MkdirAll(filepath.Dir(name), pythonManifestDirectoryMode); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, entry.data, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"INSTALLER", "REQUESTED", "direct_url.json", "uv_cache.json", "RECORD"} {
		file := filepath.Join(site, metadata, name)
		if err := os.WriteFile(file, []byte("installer-owned"), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	wheel := filepath.Join(t.TempDir(), pythonFixtureRoot+"-py3-none-any.whl")
	if err := os.WriteFile(wheel, pythonFixtureZip(t, entries), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	return pythonInstalledFixture{site: site, wheel: wheel}
}

func (fixture pythonInstalledFixture) run(t *testing.T, expected int) []byte {
	t.Helper()
	var output, diagnostic bytes.Buffer
	code := runPythonArchive([]string{
		pythonInstalledMode, fixture.wheel,
		pythonFixturePackage, pythonFixtureVersion, fixture.site,
	}, &output, &diagnostic)
	if code != expected || strings.Contains(diagnostic.String(), "sensitive-marker") ||
		strings.Contains(diagnostic.String(), fixture.site) {
		t.Fatalf("installed check returned code %d, expected %d", code, expected)
	}
	if code == exitOK && diagnostic.Len() != 0 || code != exitOK && (output.Len() != 0 || diagnostic.Len() == 0) {
		t.Fatal("installed check returned contradictory output")
	}
	return output.Bytes()
}

func TestPythonInstalledWheelBindsFiles(t *testing.T) {
	t.Parallel()
	fixture := pythonInstallFixture(t)
	if !checkPackageDocument(fixture.run(t, exitOK), jsonFields,
		[]string{`scope="python_installed_wheel_identity"`, "files=4", "valid=true"}) {
		t.Fatal("installed wheel receipt omitted its identity or exact compared-file count")
	}
}

func TestPythonInstalledWheelRejectsChangedFiles(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{
		"replaced-module", pythonInstalledFixtureMissing, "extra-module", "bytecode",
		pythonInstalledFixtureLink, "metadata-edit",
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			fixture := pythonInstallFixture(t)
			fixture.mutate(t, mutation)
			fixture.run(t, exitFailure)
		})
	}
}

func (fixture pythonInstalledFixture) mutate(t *testing.T, mutation string) {
	t.Helper()
	file := filepath.Join(fixture.site, pythonInstalledFixtureModule, "__init__.py")
	switch mutation {
	case pythonInstalledFixtureMissing, pythonInstalledFixtureLink:
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
		if mutation == pythonInstalledFixtureLink {
			if err := os.Symlink(fixture.wheel, file); err != nil {
				t.Fatal(err)
			}
		}
		return
	case "extra-module":
		file = filepath.Join(fixture.site, pythonInstalledFixtureModule, "unexpected.py")
	case "bytecode":
		file = filepath.Join(fixture.site, pythonInstalledFixtureModule, "__init__.pyc")
	case "metadata-edit":
		file = filepath.Join(fixture.site, pythonFixtureWheelMetadata)
	default:
	}
	if err := os.WriteFile(file, []byte("sensitive-marker"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
}

func TestPythonInstalledWheelRejectsUnsupportedLayout(t *testing.T) {
	t.Parallel()
	fixture := pythonInstallFixture(t)
	data, readable := readCheckFile(fixture.wheel)
	entries, parsed := readPythonArchive(data, pythonWheel)
	if !readable || !parsed {
		t.Fatal("valid installed fixture was unreadable")
	}
	for _, name := range []string{"outside.py", "logbrew_flask-0.1.5.data/purelib/outside.py", "load.pth"} {
		wheel := pythonFixtureZip(t, append(entries, pythonFixtureFile(name, "code")))
		if err := os.WriteFile(fixture.wheel, wheel, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
		fixture.run(t, exitFailure)
	}
}

func TestPythonInstalledWheelRejectsDirectoryChanges(t *testing.T) {
	t.Parallel()
	for _, linked := range []bool{false, true} {
		fixture := pythonInstallFixture(t)
		examples := filepath.Join(fixture.site, pythonInstalledFixtureModule, "examples")
		moved := filepath.Join(t.TempDir(), "examples")
		if err := os.Rename(examples, moved); err != nil {
			t.Fatal(err)
		}
		if linked {
			if err := os.Symlink(moved, examples); err != nil {
				t.Fatal(err)
			}
		}
		fixture.run(t, exitFailure)
	}
	fixture := pythonInstallFixture(t)
	directory := filepath.Join(fixture.site, pythonInstalledFixtureModule, "unlisted")
	if err := os.Mkdir(directory, pythonManifestDirectoryMode); err != nil {
		t.Fatal(err)
	}
	fixture.run(t, exitFailure)
}

func TestPythonInstalledWheelBoundsInventory(t *testing.T) {
	t.Parallel()
	fixture := pythonInstallFixture(t)
	root, err := os.OpenRoot(fixture.site)
	if err != nil {
		t.Fatal(err)
	}
	_, withinLimit := readPythonDirectory(root, 1)
	closeError := root.Close()
	if withinLimit || closeError != nil {
		t.Fatal("directory entries exceeded their allocation limit")
	}
	deep := "logbrew_flask/" + strings.Repeat("a/", pythonArchiveMemberLimit) + "end.py"
	if _, valid := pythonInstallLayout([]pythonArchiveEntry{pythonFixtureFile(deep, "")},
		pythonFixturePackage, pythonFixtureVersion); valid {
		t.Fatal("archive ancestors exceeded the installed inventory budget")
	}
}

func TestPythonInstalledWheelRejectsMetadataInjection(t *testing.T) {
	t.Parallel()
	fixture := pythonInstallFixture(t)
	metadata := filepath.Join(fixture.site, pythonFixtureRoot+".dist-info")
	if err := os.WriteFile(filepath.Join(metadata, "unlisted.py"), []byte("code"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	fixture.run(t, exitFailure)
}
