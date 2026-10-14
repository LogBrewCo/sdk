package main

import (
	"reflect"
	"testing"
)

func TestRegistryMavenVersions(t *testing.T) {
	t.Parallel()
	data := `<metadata><versioning><latest>2.0.0</latest><release>1.0.0</release><versions>` +
		`<version>1.0.0</version><version>2.0.0-rc1</version><version></version>` +
		`<version> 0.9.0 </version></versions></versioning></metadata>`
	whitespaceVersion := " 0.9.0 "
	want := map[string]bool{
		"2.0.0": true, registryCratesFixtureVersion: true, "2.0.0-rc1": true, whitespaceVersion: true,
	}
	if got := registryMavenVersions(data); !reflect.DeepEqual(got, want) {
		t.Fatalf("Maven version labels changed: %v", got)
	}
	for _, invalid := range []any{
		nil,
		map[string]any{},
		"<metadata>", "<metadata/>",
		`<!DOCTYPE metadata><metadata/>`,
		`<metadata xmlns="urn:other"><versioning><latest>1</latest></versioning></metadata>`,
	} {
		if len(registryMavenVersions(invalid)) != 0 {
			t.Fatal("malformed or unrelated Maven metadata exposed versions")
		}
	}
}
