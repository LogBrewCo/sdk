package main

import (
	"reflect"
	"testing"
)

func TestRegistrySimpleVersions(t *testing.T) {
	t.Parallel()
	for _, payload := range []any{nil, []any{}, map[string]any{}, map[string]any{pythonManifestVersion: false}} {
		if len(registryRubyVersions(payload)) != 0 || len(registryNugetVersions(payload)) != 0 ||
			len(registryPackagistVersions(payload, "logbrew/sdk")) != 0 {
			t.Fatal("malformed registry payload exposed versions")
		}
	}
	version := "1.2.3-beta.1"
	if !reflect.DeepEqual(registryRubyVersions(map[string]any{pythonManifestVersion: version}),
		map[string]bool{version: true}) {
		t.Fatal("Ruby version omitted")
	}
	nuget := map[string]any{registryVersionsField: []any{version, nil, false, version, ""}}
	if !reflect.DeepEqual(registryNugetVersions(nuget), map[string]bool{version: true, "": true}) {
		t.Fatal("NuGet string version extraction changed")
	}
	packagist := map[string]any{"packages": map[string]any{"logbrew/sdk": []any{
		map[string]any{pythonManifestVersion: version},
		map[string]any{pythonManifestVersion: ""},
		false,
		map[string]any{pythonManifestVersion: nil},
	}}}
	if !reflect.DeepEqual(registryPackagistVersions(packagist, "logbrew/sdk"),
		map[string]bool{version: true, "": true}) || len(registryPackagistVersions(packagist, "other/package")) != 0 {
		t.Fatal("Packagist selected-package extraction changed")
	}
}
