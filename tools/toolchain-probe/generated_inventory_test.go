package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestGeneratedInventoryContainedAncestorLink(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{"packages/logbrew-php/vendor/library.txt": "dependency"})
	if err := os.Symlink("packages", filepath.Join(root.Name(), "php")); err != nil {
		t.Fatal(err)
	}
	result := generatedArtifacts(root, generatedEntryLimit)
	if !result.complete || !reflect.DeepEqual(result.paths, []string{"php/logbrew-php/vendor"}) {
		t.Fatalf("linked exact artifact inventory = %+v", result)
	}
}

func TestGeneratedInventoryEscapingLink(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{})
	if err := os.Symlink(t.TempDir(), filepath.Join(root.Name(), "php")); err != nil {
		t.Fatal(err)
	}
	if result := generatedArtifacts(root, generatedEntryLimit); result.complete {
		t.Fatal("escaping exact artifact lookup claimed completion")
	}
}

func TestGeneratedInventoryDanglingArtifacts(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{})
	for _, name := range []string{generatedCargoLock, "cached.pyc"} {
		if err := os.Symlink("missing-output", filepath.Join(root.Name(), name)); err != nil {
			t.Fatal(err)
		}
	}
	result := generatedArtifacts(root, generatedEntryLimit)
	if !result.complete || !reflect.DeepEqual(result.paths, []string{generatedCargoLock, "cached.pyc"}) {
		t.Fatalf("dangling artifact inventory = %+v", result)
	}
}

func TestGeneratedInventory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{
		generatedCargoLock:                                 "lock",
		"php/logbrew-php/vendor/dependency.txt":            "vendor dependency",
		"js/logbrew-js/examples/node_modules/module.js":    "module",
		"js/logbrew-js/examples/pnpm-lock.yaml":            "lockfile",
		"python/logbrew_py/tests/__pycache__/module.pyc":   "compiled cache entry",
		"python/logbrew_flask/dist/package.whl":            "artifact",
		"examples/module.pyc":                              "compiled module",
		"dotnet/logbrew-dotnet/src/LogBrew/bin/output.dll": "assembly",
		"c/logbrew-c/file.o":                               "object",
		".git/ignored.pyc":                                 "ignored",
		"docs/readme.md":                                   "# Docs",
	})
	result := generatedArtifacts(root, generatedEntryLimit)
	want := []string{
		generatedCargoLock,
		"c/logbrew-c/file.o", "dotnet/logbrew-dotnet/src/LogBrew/bin",
		"examples/module.pyc", "js/logbrew-js/examples/node_modules",
		"js/logbrew-js/examples/pnpm-lock.yaml", "php/logbrew-php/vendor",
		"python/logbrew_flask/dist", "python/logbrew_py/tests/__pycache__",
		"python/logbrew_py/tests/__pycache__/module.pyc",
	}
	if !result.complete || !reflect.DeepEqual(result.paths, want) {
		t.Fatalf("generated artifacts = %v, want %v", result.paths, want)
	}
}

func TestGeneratedInventoryLimitAndEmpty(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{"docs/readme.md": "# Docs"})
	if result := generatedArtifacts(root, 1); result.complete {
		t.Fatal("truncated artifact discovery claimed completion")
	}
	result := generatedArtifacts(root, generatedEntryLimit)
	if !result.complete || len(result.paths) != 0 {
		t.Fatal("clean generated artifact inventory failed")
	}
}
