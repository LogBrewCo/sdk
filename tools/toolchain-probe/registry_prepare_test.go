package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegistryPrepareMavenPlan(t *testing.T) {
	t.Parallel()
	const planFileMode = 0o600
	name := filepath.Join(t.TempDir(), "plan.json")
	const plan = `{"schemaVersion":1,"selected":[{"artifactId":"logbrew-kotlin",` +
		`"coordinate":"co.logbrew:logbrew-kotlin","version":"0.4.5"}],"externalDependencies":[]}`
	if err := os.WriteFile(name, []byte(plan), planFileMode); err != nil {
		t.Fatal(err)
	}
	args := append(strings.Fields(`--target=maven --maven-plan-scope=selected --expect-absent`), "--maven-plan", name)
	options := prepareRegistryOptions(args)
	if options == nil || !options.selection.mavenPlan {
		t.Fatal("valid plan unavailable")
	}
	checks, valid := registryPlanChecks(options.selection, options.versions)
	if !valid || len(checks) != 1 || !checks[0].expected["0.4.5"] {
		t.Fatal("file plan lost version binding")
	}
	args = []string{"--target=maven", "--maven-plan", name, "--maven-plan-scope=dependencies"}
	options = prepareRegistryOptions(args)
	if options == nil {
		t.Fatal("empty dependency scope rejected")
	}
	checks, valid = registryPlanChecks(options.selection, options.versions)
	if !valid || len(checks) != 0 {
		t.Fatal("empty dependency plan fell back to defaults")
	}
	for _, data := range []string{"{broken", strings.Repeat(" ", pythonManifestLimit+1)} {
		if err := os.WriteFile(name, []byte(data), planFileMode); err != nil {
			t.Fatal(err)
		}
		if prepareRegistryOptions(args) != nil {
			t.Fatal("invalid or oversized file accepted")
		}
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	if prepareRegistryOptions(args) != nil {
		t.Fatal("missing plan accepted")
	}
}
