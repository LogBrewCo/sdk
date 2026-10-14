package main

import "testing"

func TestRegistryDefaultVersions(t *testing.T) {
	t.Parallel()
	const defaultCheckCount = 31
	selection := new(registrySelection)
	selection.targets = []string{releaseMetadataAll}
	selection.crates, selection.packagist, selection.maven, selection.openupm = true, true, true, true
	policy := newRegistryVersionPolicy()
	checks, valid := registryPlanChecks(selection, policy)
	if !valid || len(checks) != defaultCheckCount {
		t.Fatalf("default plan length %d valid %v", len(checks), valid)
	}
	for _, check := range checks {
		expected := registryDefaultVersion
		switch check.request.family {
		case registryRubyFamily:
			expected = registryRubyVersion
		case registryPackagistFamily:
			expected = registryPackagistVersion
		case registryCratesFamily:
			expected = registryRustVersion
		case mavenMetadataFamily:
			expected = registryMavenVersion
		default:
		}
		if !check.expected[expected] {
			t.Fatalf("%s lost default %s", check.request.label, expected)
		}
	}
	policy.defaults[registryRubyFamily][pythonCoreID] = fixtureUnknown
	if newRegistryVersionPolicy().defaults[registryRubyFamily][pythonCoreID] != registryRubyVersion {
		t.Fatal("default policy shares mutable version maps")
	}
}
