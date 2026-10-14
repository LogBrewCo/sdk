package main

import (
	"net/http"
	"testing"
)

func TestRegistryAbsentResult(t *testing.T) {
	t.Parallel()
	forbidden := map[string]bool{pythonFixtureVersion: true}
	for _, test := range []struct {
		found           map[string]bool
		status          int
		readable, valid bool
	}{
		{nil, http.StatusNotFound, false, true},
		{nil, http.StatusOK, true, false},
		{forbidden, http.StatusOK, true, false},
		{map[string]bool{"1.2.2": true}, http.StatusOK, true, true},
		{map[string]bool{"1.2.2": true}, http.StatusOK, false, false},
		{nil, http.StatusForbidden, false, false},
		{nil, http.StatusServiceUnavailable, false, false},
	} {
		if registryAbsentResult(test.status, test.readable, test.found, forbidden) != test.valid {
			t.Fatal("registry absence availability boundary changed")
		}
	}
}

func TestRegistryExpectedVersions(t *testing.T) {
	t.Parallel()
	for _, version := range []string{pythonFixtureVersion, "v" + pythonFixtureVersion} {
		versions := registryExpectedVersions("npm", version)
		if !versions[pythonFixtureVersion] || !versions["v"+pythonFixtureVersion] || len(versions) != 2 {
			t.Fatal("registry v-prefix compatibility changed")
		}
	}
	versions := registryExpectedVersions(mavenMetadataFamily, "v"+pythonFixtureVersion)
	if !versions["v"+pythonFixtureVersion] || versions[pythonFixtureVersion] || len(versions) != 1 {
		t.Fatal("Maven exact version label changed")
	}
}
