package main

import (
	"reflect"
	"testing"
)

func TestRegistryPlanChecks(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.targets = []string{mavenMetadataFamily, registryNPMFamily}
	selection.npmPackages = []string{jsMetadataCore}
	selection.mavenArtifacts = []string{mavenMetadataKotlin}
	policy := new(registryVersionPolicy)
	policy.version = "v0.1.0"
	policy.defaults = map[string]map[string]string{mavenMetadataFamily: {"co.logbrew:logbrew-kotlin": "0.2.2"}}
	policy.overrides = map[string]map[string]string{registryNPMFamily: {jsMetadataCore: "1.2.3+build"}}
	checks, valid := registryPlanChecks(selection, policy)
	if !valid || len(checks) != 2 {
		t.Fatalf("plan = %v valid %v", checks, valid)
	}
	if checks[0].request.label != jsMetadataCore || !reflect.DeepEqual(checks[0].expected,
		map[string]bool{"1.2.3+build": true, "v1.2.3+build": true}) {
		t.Fatal("npm override binding failed")
	}
	if !reflect.DeepEqual(checks[1].expected, map[string]bool{"0.2.2": true}) {
		t.Fatal("Maven default binding failed")
	}
	policy.provenance = true
	checks, valid = registryPlanChecks(selection, policy)
	if !valid || checks[0].request.family != "npm-provenance" || len(checks[0].expected) != 1 ||
		checks[0].request.address != "https://registry.npmjs.org/%40logbrew%2Fsdk/1.2.3%2Bbuild" {
		t.Fatal("provenance request binding failed")
	}
	policy.absent = true
	checks, valid = registryPlanChecks(selection, policy)
	if !valid || checks[0].request.family != registryNPMFamily {
		t.Fatal("absence substituted provenance")
	}
	policy.overrides[registryNPMFamily][jsMetadataCore] = ""
	if _, valid = registryPlanChecks(selection, policy); valid {
		t.Fatal("empty override accepted")
	}
	if _, valid = registryPlanChecks(selection, nil); valid {
		t.Fatal("nil policy accepted")
	}
	if _, valid = registryPlanChecks(nil, policy); valid {
		t.Fatal("nil selection accepted")
	}
}
