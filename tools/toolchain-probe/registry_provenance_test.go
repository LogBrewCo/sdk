package main

import "testing"

func TestRegistryNPMProvenance(t *testing.T) {
	t.Parallel()
	version := "1.2.3+build/tag space"
	address := registryNPMAttestations + "@logbrew%2fsdk@1.2.3%2Bbuild%2Ftag%20space"
	for _, test := range []struct {
		address, predicate string
		valid              bool
	}{
		{address, registryNPMPredicate, true},
		{address + "extra", registryNPMPredicate, false},
		{address, "unknown-predicate", false},
		{"https://example.com/@1.2.3%2Bbuild%2Ftag%20space", registryNPMPredicate, false},
		{registryNPMAttestations + "@sdk@" + version, registryNPMPredicate, false},
	} {
		payload := map[string]any{
			pythonManifestVersion: version, "dist": map[string]any{"attestations": map[string]any{
				"url": test.address, "provenance": map[string]any{"predicateType": test.predicate},
			}},
		}
		if registryNPMProvenanceVersions(payload)[version] != test.valid {
			t.Fatal("npm provenance predicate or exact encoded version binding changed")
		}
	}
	for _, payload := range []any{nil, []any{}, map[string]any{"dist": false}} {
		if len(registryNPMProvenanceVersions(payload)) != 0 {
			t.Fatal("malformed provenance accepted")
		}
	}
}
