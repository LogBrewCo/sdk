package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const nugetFixtureVersion = "0.1.7"

func nugetFixtureSelections() map[string]string {
	return map[string]string{
		"": "LogBrew,LogBrew.AspNetCore,LogBrew.EntityFrameworkCore,LogBrew.Hangfire,LogBrew.HttpClient," +
			"LogBrew.StackExchangeRedis,LogBrew.OpenTelemetry",
		"LogBrew.HttpClient, LogBrew": "LogBrew,LogBrew.HttpClient",
		"LogBrew.AspNetCore":          "LogBrew.AspNetCore",
		"LogBrew.EntityFrameworkCore": "LogBrew.EntityFrameworkCore",
		"LogBrew.Hangfire":            "LogBrew.Hangfire", "LogBrew.StackExchangeRedis": "LogBrew.StackExchangeRedis",
		"LogBrew.OpenTelemetry": "LogBrew.OpenTelemetry",
	}
}

func TestNugetPlanSelections(t *testing.T) {
	t.Parallel()
	for raw, expected := range nugetFixtureSelections() {
		if selected := nugetPlanSelection(raw); strings.Join(selected, ",") != expected {
			t.Fatal("NuGet package selection or canonical order changed")
		}
	}
	for _, raw := range nugetInvalidSelections() {
		if nugetPlanSelection(raw) != nil {
			t.Fatal("invalid NuGet release set accepted")
		}
	}
}

func nugetInvalidSelections() []string {
	return []string{
		"Unknown.Package", "LogBrew", "LogBrew.HttpClient", "LogBrew,LogBrew.AspNetCore", "LogBrew,LogBrew",
		"LogBrew,,LogBrew.HttpClient", "LogBrew,", "logbrew", "LogBrew\nLogBrew.HttpClient",
		"LogBrew\rLogBrew.HttpClient", `LogBrew; printf "unsafe"`, "LogBrew$(id)",
		strings.Repeat("x", nugetPlanSelectionLimit+1),
	}
}

func TestNugetPlanMetadataAndDrift(t *testing.T) {
	t.Parallel()
	root := publishFixtureRoot(t, "../..")
	plan := nugetPlanAtRoot(root, "LogBrew.HttpClient, LogBrew")
	const expected = `{"schemaVersion":1,"selectionMode":"selected","selected":[
		{"packageId":"LogBrew","projectPath":"dotnet/logbrew-dotnet/src/LogBrew/LogBrew.csproj",
		"version":"0.1.7","versionOutput":"core_version"},
		{"packageId":"LogBrew.HttpClient",
		"projectPath":"dotnet/logbrew-dotnet/src/LogBrew.HttpClient/LogBrew.HttpClient.csproj",
		"version":"0.1.2","versionOutput":"httpclient_version"}]}`
	document, valid := decodeCheckDocument([]byte(expected))
	if !valid || !reflect.DeepEqual(plan, document) || !validNugetPlan(root, []byte(expected)) {
		t.Fatal("saved NuGet plan contract changed")
	}
	for before, after := range map[string]string{
		nugetFixtureVersion: "9.9.9", "core_version": fixtureUnknown, `"schemaVersion":1`: `"schemaVersion":true`,
		`"selectionMode":"selected"`: `"selectionMode":"all"`,
		`"packageId":"LogBrew"`:      `"packageId":"Unknown.Package"`,
		`"version":"0.1.7"`:          `"version":"0.1.7","version":"9.9.9"`,
	} {
		if validNugetPlan(root, []byte(strings.ReplaceAll(expected, before, after))) {
			t.Fatal("saved plan accepted stale or contradictory metadata")
		}
	}
	all := nugetPlanAtRoot(root, "")
	data, err := json.Marshal(all)
	if err != nil || !validNugetPlan(root, data) {
		t.Fatal("all-package plan unavailable")
	}
}

func TestNugetPlanConsumerFixture(t *testing.T) {
	t.Parallel()
	root := publishFixtureRoot(t, "testdata/nuget-release")
	data, readable := readReleaseMetadata(root, "plan.json")
	if !readable || !validNugetPlan(root, data) {
		t.Fatal("consumer failure-stage fixture is not a valid native plan")
	}
	document, decoded := decodeCheckDocument(data)
	versions, valid := nugetPlanEntryText(eventObject(document), "versions")
	if !decoded || !valid || versions != "LogBrew=0.1.5\nLogBrew.HttpClient=0.1.0\n" {
		t.Fatal("consumer fixture package selection changed")
	}
	plan := eventObject(document)
	entries, array := plan[nugetPlanSelected].([]any)
	if !array || len(entries) != 2 {
		t.Fatal("fixture must contain the selected core pair")
	}
	plan[nugetPlanSelected] = entries[:1]
	data, err := json.Marshal(plan)
	if err != nil || validNugetPlan(root, data) {
		t.Fatal("saved selected plan accepted the core package without HttpClient")
	}
}
