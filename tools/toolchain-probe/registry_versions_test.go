package main

import (
	"reflect"
	"testing"
)

func TestRegistryObjectVersions(t *testing.T) {
	t.Parallel()
	for _, registry := range []struct {
		extract                    func(any) map[string]bool
		metadata, current, entries string
	}{
		{registryNPMVersions, "dist-tags", registryLatestTag, registryVersionsField},
		{registryPyPIVersions, registryInfoField, pythonManifestVersion, "releases"},
	} {
		for _, test := range []struct {
			payload any
			want    map[string]bool
		}{
			{nil, map[string]bool{}},
			{[]any{}, map[string]bool{}},
			{
				map[string]any{registry.metadata: map[string]any{registry.current: dotnetMetadataInitialVersion}},
				map[string]bool{dotnetMetadataInitialVersion: true},
			},
			{
				map[string]any{registry.metadata: map[string]any{registry.current: false}, registry.entries: []any{}},
				map[string]bool{},
			},
			{
				map[string]any{
					registry.metadata: map[string]any{registry.current: ""},
					registry.entries:  map[string]any{dotnetMetadataInitialVersion: nil, "0.2.0rc1": []any{}},
				},
				map[string]bool{dotnetMetadataInitialVersion: true, "0.2.0rc1": true},
			},
		} {
			if got := registry.extract(test.payload); !reflect.DeepEqual(got, test.want) {
				t.Errorf("%s versions: got %v, want %v", registry.entries, got, test.want)
			}
		}
	}
}
