package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pythonBytecodeFixture(t *testing.T) (pythonInstalledFixture, pythonInstalledLayout, *os.Root) {
	t.Helper()
	fixture := pythonInstallFixture(t)
	data, readable := readCheckFile(fixture.wheel)
	entries, parsed := readPythonArchive(data, pythonWheel)
	layout, valid := pythonInstallLayout(entries, pythonFixturePackage, pythonFixtureVersion)
	if !readable || !parsed || !valid {
		t.Fatal("invalid bytecode fixture wheel")
	}
	reference, err := os.OpenRoot(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := reference.Close(); err != nil {
			t.Error(err)
		}
	})
	return fixture, layout, reference
}

func pythonBytecodeFixtureOutput(t *testing.T, root *os.Root, source, tag string) string {
	t.Helper()
	name := filepath.Join(filepath.Dir(source), "__pycache__",
		strings.TrimSuffix(filepath.Base(source), ".py")+"."+tag+".pyc")
	if err := root.MkdirAll(filepath.Dir(name), pythonManifestDirectoryMode); err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile(name, []byte("compiler-output-fixture"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestPythonBytecodeStagesVerifiedModule(t *testing.T) {
	t.Parallel()
	fixture, layout, reference := pythonBytecodeFixture(t)
	if !layout.stagePythonModule(fixture.site, reference) {
		t.Fatal("verified source staging failed")
	}
	for name, expected := range layout.files {
		if !strings.HasPrefix(name, layout.module+"/") {
			continue
		}
		actual, err := reference.ReadFile(name)
		staged, statError := reference.Stat(name)
		installed, sourceError := os.Stat(filepath.Join(fixture.site, name))
		if err != nil || statError != nil || sourceError != nil || !bytes.Equal(actual, expected) ||
			!staged.ModTime().Equal(installed.ModTime()) {
			t.Fatal("reference did not preserve wheel source and installed timestamp")
		}
	}
	if layout.stagePythonModule(fixture.site, reference) {
		t.Fatal("reference staging overwrote an existing source")
	}
}

func TestPythonBytecodeRejectsChangedStagingInput(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{"replaced-module", pythonInstalledFixtureMissing, pythonInstalledFixtureLink} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			fixture, layout, reference := pythonBytecodeFixture(t)
			fixture.mutate(t, mutation)
			if layout.stagePythonModule(fixture.site, reference) {
				t.Fatal("unverified installed source entered the compilation reference")
			}
		})
	}
}

func TestPythonBytecodeBindsExactCompilerOutput(t *testing.T) {
	t.Parallel()
	fixture, layout, reference := pythonBytecodeFixture(t)
	if !layout.stagePythonModule(fixture.site, reference) {
		t.Fatal("reference staging failed")
	}
	installed, err := os.OpenRoot(fixture.site)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := installed.Close(); err != nil {
			t.Error(err)
		}
	}()
	var bytecode string
	for name := range layout.files {
		if strings.HasSuffix(name, ".py") {
			bytecode = pythonBytecodeFixtureOutput(t, reference, name, "cpython-313")
			pythonBytecodeFixtureOutput(t, installed, name, "cpython-313")
		}
	}
	fixture.run(t, exitFailure)
	if !layout.bindPythonBytecode(reference) || !layout.verify(fixture.site) {
		t.Fatal("exact compiler output did not verify")
	}
	if err := installed.WriteFile(bytecode, []byte("changed"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	if layout.verify(fixture.site) {
		t.Fatal("bytecode changed after compilation proof was accepted")
	}
}

func TestPythonBytecodeRejectsIncompleteReference(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{
		"missing-cache", "extra-cache", "duplicate-tag", "optimized-cache", "linked-cache", "source",
		"oversized-cache", "linked-cache-directory", "extra-directory",
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			fixture, layout, reference := pythonBytecodeFixture(t)
			if !layout.stagePythonModule(fixture.site, reference) {
				t.Fatal("reference staging failed")
			}
			var bytecode, source string
			for name := range layout.files {
				if strings.HasSuffix(name, ".py") {
					source = name
					bytecode = pythonBytecodeFixtureOutput(t, reference, name, "cpython-313")
				}
			}
			mutatePythonBytecodeReference(t, reference, mutation, source, bytecode)
			if layout.bindPythonBytecode(reference) {
				t.Fatal("incomplete or changed compiler reference was accepted")
			}
		})
	}
}

func mutatePythonBytecodeReference(t *testing.T, root *os.Root, mutation, source, bytecode string) {
	t.Helper()
	var err error
	switch mutation {
	case "extra-cache":
		pythonBytecodeFixtureOutput(t, root, layoutExtraPythonSource, "cpython-313")
	case "duplicate-tag":
		pythonBytecodeFixtureOutput(t, root, source, "cpython-314")
	case "optimized-cache":
		pythonBytecodeFixtureOutput(t, root, source, "cpython-313.opt-1")
	case "oversized-cache":
		err = root.WriteFile(bytecode, bytes.Repeat([]byte("x"), pythonArchiveMemberBytes+1), fixtureReceiptMode)
	case "linked-cache-directory":
		directory := filepath.Dir(bytecode)
		err = root.Rename(directory, directory+"-moved")
		if err == nil {
			err = root.Symlink(filepath.Base(directory)+"-moved", directory)
		}
	case "extra-directory":
		err = root.Mkdir("logbrew_flask/unexpected", pythonManifestDirectoryMode)
	case "source":
		err = root.WriteFile(source, []byte("changed"), fixtureReceiptMode)
	default:
		err = root.Remove(bytecode)
		if err == nil && mutation == "linked-cache" {
			err = root.Symlink(filepath.Base(source), bytecode)
		}
	}
	if err != nil {
		t.Fatal(err)
	}
}

const layoutExtraPythonSource = "logbrew_flask/unexpected.py"

func TestPythonPublicSmokeCanonicalSite(t *testing.T) {
	t.Parallel()
	venv := t.TempDir()
	site := filepath.Join(venv, "lib", "python3.13", "site-packages")
	if err := os.MkdirAll(site, pythonManifestDirectoryMode); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "environment")
	if err := os.Symlink(venv, alias); err != nil {
		t.Fatal(err)
	}
	expected, err := filepath.EvalSymlinks(site)
	actual, valid := pythonSmokeSite(alias)
	if err != nil || !valid || actual != expected {
		t.Fatal("bytecode reference prefix does not match the interpreter's canonical site path")
	}
}
