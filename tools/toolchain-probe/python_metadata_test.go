package main

import (
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestPythonReleaseMetadata(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil || runPythonMetadata([]string{root}, io.Discard, io.Discard) != exitOK {
		t.Fatal("public Python repository metadata rejected")
	}
	for _, spec := range pythonReleaseCatalog() {
		t.Run(spec.id, func(t *testing.T) {
			t.Parallel()
			checkPythonReleaseMetadata(t, spec)
		})
	}
}

func checkPythonReleaseMetadata(t *testing.T, spec pythonReleaseSpec) {
	t.Helper()
	data := repositorySource(t, "python/"+spec.directory+"/pyproject.toml")
	if !validPythonMetadata([]byte(data), spec.id) {
		t.Fatal("canonical Python release metadata rejected")
	}
	for _, mutation := range []string{
		strings.Replace(data, `license = "MIT"`, `license = "unknown"`, 1),
		strings.Replace(data, `requires-python = ">=3.10"`, `requires-python = ">=3.11"`, 1),
		strings.Replace(data, `readme = "README.md"`, `readme = false`, 1),
		strings.Replace(data, `name = "LogBrew"`, `name = "unknown"`, 1),
		strings.Replace(data, `name = "`+spec.id+`"`, `name = "unknown"`, 1),
		strings.Replace(data, "description = ", "description = false #", 1),
		strings.Replace(data, "Repository = ", "Repository = false #", 1),
		strings.Replace(data, `keywords = ["logbrew"`, `keywords = ["unknown"`, 1),
		strings.Replace(data, "dependencies = [", `dependencies = ["unexpected",`, 1),
		strings.Replace(data, "[project]", "[project]\nname = 'duplicate'", 1),
		data + "\n[project]\n",
	} {
		if mutation == data || validPythonMetadata([]byte(mutation), spec.id) {
			t.Error("invalid metadata accepted or mutation did not apply")
		}
	}
	policy := pythonMetadataPolicies()[spec.id]
	dependencies := append([]string{policy.version}, policy.dependencies...)
	for _, extra := range policy.optional {
		dependencies = append(dependencies, extra...)
	}
	for _, dependency := range dependencies {
		mutation := strings.Replace(data, dependency, "unsupported", 1)
		if mutation == data || validPythonMetadata([]byte(mutation), spec.id) {
			t.Error("missing version or dependency requirement accepted")
		}
	}
}

func TestPythonReleaseMetadataRejectsMalformedInput(t *testing.T) {
	t.Parallel()
	for _, data := range []string{
		"", "[project", "project = 42", "[project]\nname='\xff'",
		strings.Repeat(" ", pythonManifestLimit+1),
	} {
		if validPythonMetadata([]byte(data), pythonCoreID) {
			t.Error("malformed or oversized metadata accepted")
		}
	}
	if validPythonMetadata([]byte(repositorySource(t, "python/logbrew_py/pyproject.toml")), "unknown") {
		t.Fatal("unknown package accepted")
	}
}
