package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestRegistryMavenPlan(t *testing.T) {
	t.Parallel()
	const selected = `{"schemaVersion":1,"selected":[{"artifactId":"logbrew-kotlin",` +
		`"coordinate":"co.logbrew:logbrew-kotlin","version":"0.2.2+build"}],"externalDependencies":[]}`
	plan, valid := registryReadMavenPlan([]byte(selected), nugetPlanSelected)
	if !valid || !reflect.DeepEqual(plan.artifacts, []string{mavenMetadataKotlin}) ||
		plan.versions["co.logbrew:logbrew-kotlin"] != "0.2.2+build" {
		t.Fatalf("plan = %v valid %v", plan, valid)
	}
	plan, valid = registryReadMavenPlan([]byte(selected), "dependencies")
	if !valid || len(plan.artifacts) != 0 || len(plan.versions) != 0 {
		t.Fatal("empty dependency closure rejected")
	}
	for _, data := range []string{
		` null `, `{}`, `{"schemaVersion":1,"selected":[]}`, `{"schemaVersion":1,"selected":[null]}`,
		strings.Replace(selected, `"schemaVersion":1`, `"schemaVersion":"1"`, 1),
		strings.Replace(selected, `"schemaVersion":1`, `"schemaVersion":2`, 1),
		strings.Replace(selected, `"co.logbrew:logbrew-kotlin"`, `"other:logbrew-kotlin"`, 1),
		strings.Replace(selected, `"version":"0.2.2+build"`, `"version":""`, 1),
		strings.Replace(selected, `"version":"0.2.2+build"`, `"version":22`, 1),
		strings.ReplaceAll(selected, "logbrew-kotlin", "unknown-artifact"),
		strings.Replace(selected, `],"externalDependencies"`, `,{"artifactId":"logbrew-kotlin",`+
			`"coordinate":"co.logbrew:logbrew-kotlin","version":"9"}],"externalDependencies"`, 1),
	} {
		if _, valid = registryReadMavenPlan([]byte(data), nugetPlanSelected); valid {
			t.Fatalf("accepted malformed plan %s", data)
		}
	}
	if _, valid = registryReadMavenPlan([]byte(selected), fixtureUnknown); valid {
		t.Fatal("unknown scope accepted")
	}
}
