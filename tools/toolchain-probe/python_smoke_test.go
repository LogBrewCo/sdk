package main

import (
	"maps"
	"os"
	"path/filepath"
	"testing"
)

const (
	pythonSmokeFixtureCore    = "0.1.16"
	pythonSmokeFixtureAdapter = "0.1.6"
	pythonSmokeFixtureExtras  = "[dramatiq,arq,rq]"
)

func TestPythonPublicSmokeChecksRuntimeBeforeInventory(t *testing.T) {
	t.Parallel()
	requireOrderedSource(t, repositorySource(t, "tools/toolchain-probe/python_smoke.go"),
		"run.install(ctx)", "run.prepareBytecode(ctx, site)", `"installed bytes before runtime"`,
		"checkPythonPublicRuntime(ctx,", `"installed runtime evidence"`,
		`{"show", pythonCoreID, pythonFastAPIID, pythonFlaskID, pythonDjangoID}`,
		`{"list", "--format=json"}`, `{"freeze"}`, `"installed dependency inventory"`,
		`"installed bytes after runtime"`,
	)
}

func TestPythonPublicSmokeSelection(t *testing.T) {
	t.Parallel()
	lookup := func(string) string { return "" }
	selection, valid := parsePythonSmokeOptions(nil, lookup)
	want := map[string]string{
		"logbrew-sdk": "0.1.14", "logbrew-fastapi": "0.1.10",
		pythonFixturePackage: "0.1.5", "logbrew-django": pythonSmokeFixtureAdapter,
	}
	if !valid || !maps.Equal(selection.versions, want) || selection.receipt {
		t.Fatal("public defaults changed")
	}
	arguments := []string{pythonSmokeFixtureCore, "0.1.11", "0.1.7", pythonSmokeFixtureAdapter}
	selection, valid = parsePythonSmokeOptions(arguments, lookup)
	if !valid || selection.versions["logbrew-django"] != "0.1.7" ||
		selection.versions[pythonFixturePackage] != pythonSmokeFixtureAdapter {
		t.Fatal("legacy positional Django/Flask ordering changed")
	}
	for _, args := range [][]string{
		{"--manifest"},
		{"--artifact-root", "/artifacts"},
		{"--manifest", "/public-manifest.json", pythonSmokeFixtureCore},
		{"--unknown"},
		{"../invalid"},
		{"0.1.1", "0.1.2", "0.1.3", "0.1.4", "0.1.5"},
	} {
		if _, accepted := parsePythonSmokeOptions(args, lookup); accepted {
			t.Fatalf("ambiguous public selection accepted: %v", args)
		}
	}
}

func TestPythonPublicSmokeExtras(t *testing.T) {
	t.Parallel()
	for _, sample := range []struct {
		version, expected string
	}{
		{"0.1.14", "[rq]"},
		{"0.1.15", "[arq,rq]"},
		{pythonSmokeFixtureCore, pythonSmokeFixtureExtras},
		{"0.2.0", pythonSmokeFixtureExtras},
		{"1.0.0", pythonSmokeFixtureExtras},
	} {
		if pythonSmokeExtras("logbrew-sdk", sample.version) != sample.expected {
			t.Fatalf("wrong optional dependencies for %s", sample.version)
		}
	}
	if pythonSmokeExtras("logbrew-fastapi", "0.1.7") != "" ||
		pythonSmokeExtras("logbrew-fastapi", "0.1.8") != "[celery]" ||
		pythonSmokeExtras(pythonFixturePackage, "1.0.0") != "" {
		t.Fatal("FastAPI extra floor or adapter ownership changed")
	}
}

func TestPythonPublicSmokeManifestOverridesDefaults(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	data := pythonManifestJSON(t, pythonFixtureManifest(t, directory, selection))
	filename := filepath.Join(directory, "public-selection.json")
	if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	arguments := []string{pythonSmokeManifestFlag, filename}
	options, valid := parsePythonSmokeOptions(arguments, func(string) string { return "" })
	if !valid || !maps.Equal(options.versions, selection.versions) {
		t.Fatal("returned selection retained defaults after parsing its manifest")
	}
}
