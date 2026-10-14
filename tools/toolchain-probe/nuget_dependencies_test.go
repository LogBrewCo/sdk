package main

import (
	"maps"
	"slices"
	"strings"
	"testing"
)

const (
	nugetNullJSON             = "null"
	nugetDependencyNet8       = "net8.0"
	nugetDependencyAlias      = ".NETStandard2.0"
	nugetDependencyGroupEnd   = "</ItemGroup>"
	nugetDependencyVersion    = "10.0.9"
	nugetDependencyCoreRange  = "[0.1.7, 0.2.0)"
	nugetDependencyMinimum    = "[10.0.9, )"
	nugetDependencyFrameworks = "netstandard2.0;net8.0"
	nugetDependencyFixture    = `<Project><PropertyGroup><TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>` +
		`</PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Extensions.Logging" Version="10.0.9"/>` +
		`</ItemGroup></Project>`
)

func TestNugetDependencyRanges(t *testing.T) {
	t.Parallel()
	for raw, expected := range map[string]string{
		nugetDependencyVersion: nugetDependencyMinimum, nugetDependencyMinimum: nugetDependencyMinimum,
		nugetDependencyCoreRange: nugetDependencyCoreRange,
		"1.2.3-preview.1":        "[1.2.3-preview.1, )",
	} {
		if nugetDependencyRange(raw) != expected {
			t.Fatal("supported release dependency range changed")
		}
	}
	for _, raw := range []string{
		"", "1.2", " 1.2.3", "1.2.3 ", "[1.2.3]", "(1.2.3, 2.0.0)",
		"[1.2.3,2.0.0)", "[1.2.3, *)", "[1.2.3, 2.0.0]", "[1.2.3, 2.0.0, )", "[, 2.0.0)",
	} {
		if nugetDependencyRange(raw) != "" {
			t.Fatal("unsupported release dependency range accepted")
		}
	}
}

func TestNugetSourceDependencies(t *testing.T) {
	t.Parallel()
	for _, packageID := range []string{dotnetMetadataCore, dotnetMetadataHTTP} {
		data := repositorySource(t, dotnetMetadataSource+packageID+"/"+packageID+dotnetMetadataProject)
		contract := nugetSourceDependencies([]byte(data), packageID, nugetDependencyCoreRange)
		if contract == nil ||
			!slices.Equal(contract.frameworks, []string{dotnetMetadataStandard, nugetDependencyNet8}) {
			t.Fatal("canonical source framework contract rejected")
		}
		expected := map[string]string{"Microsoft.Extensions.Logging": nugetDependencyMinimum}
		if packageID == dotnetMetadataHTTP {
			expected = map[string]string{
				"Microsoft.Extensions.Http": nugetDependencyMinimum, dotnetMetadataCore: nugetDependencyCoreRange,
			}
		}
		if !maps.Equal(contract.dependencies, expected) {
			t.Fatal("canonical source dependencies changed")
		}
	}
	alias := strings.ReplaceAll(nugetDependencyFixture, dotnetMetadataStandard, nugetDependencyAlias)
	contract := nugetSourceDependencies([]byte(alias), dotnetMetadataCore, "")
	if contract == nil || contract.frameworks[0] != nugetDependencyAlias {
		t.Fatal("source frameworks must not use registry alias normalization")
	}
}

func TestNugetSourceDependencyRejections(t *testing.T) {
	t.Parallel()
	for _, change := range [][2]string{
		{nugetDependencyFrameworks, "net8.0;net8.0"},
		{nugetDependencyFrameworks, "net8.0;"},
		{nugetDependencyFrameworks, ""},
		{"</PropertyGroup>", "<TargetFrameworks>net8.0</TargetFrameworks></PropertyGroup>"},
		{"<ItemGroup>", `<ItemGroup Condition="true">`},
		{"<PackageReference ", `<PackageReference Condition="true" `},
		{nugetDependencyVersion, "latest"},
		{`Include="Microsoft.Extensions.Logging"`, `Include=""`},
		{nugetDependencyGroupEnd, `<PackageReference Include="Microsoft.Extensions.Logging" ` +
			`Version="10.0.9"/></ItemGroup>`},
		{nugetDependencyGroupEnd, `<ProjectReference Include="../LogBrew/LogBrew.csproj"/></ItemGroup>`},
		{"<Project>", "<!DOCTYPE Project><Project>"},
		{"TargetFrameworks", "TargetFramework"},
	} {
		data := strings.ReplaceAll(nugetDependencyFixture, change[0], change[1])
		if nugetSourceDependencies([]byte(data), dotnetMetadataCore, "") != nil {
			t.Fatal("ambiguous or unsupported source dependency contract accepted")
		}
	}
	for _, id := range []string{dotnetMetadataHTTP, fixtureUnknown} {
		if nugetSourceDependencies([]byte(nugetDependencyFixture), id, nugetDependencyCoreRange) != nil {
			t.Fatal("missing adapter reference or unknown package accepted")
		}
	}
	for _, data := range []string{
		`<Project><PropertyGroup><TargetFrameworks>net8.0</TargetFrameworks></PropertyGroup></Project>`,
		strings.Repeat(" ", 512<<10) + nugetDependencyFixture,
	} {
		if nugetSourceDependencies([]byte(data), dotnetMetadataCore, "") != nil {
			t.Fatal("empty dependencies or oversized source accepted")
		}
	}
}

func TestNugetDependencyGroups(t *testing.T) {
	t.Parallel()
	contract := nugetSourceDependencies([]byte(nugetDependencyFixture), dotnetMetadataCore, "")
	validGroups := `[ {"targetFramework":".NETStandard2.0","dependencies":[` +
		`{"id":"Microsoft.Extensions.Logging","range":"10.0.9"}]},` +
		`{"targetFramework":"net8.0","dependencies":[` +
		`{"id":"Microsoft.Extensions.Logging","range":"[10.0.9, )"}]} ]`
	for _, data := range []string{
		validGroups, strings.ReplaceAll(validGroups, nugetDependencyAlias, dotnetMetadataStandard),
	} {
		value, decoded := decodeCheckDocument([]byte(data))
		if !decoded || !contract.matchesGroups(value) {
			t.Fatal("equivalent catalog dependency groups rejected")
		}
	}
	for _, change := range [][2]string{
		{nugetDependencyAlias, "NETStandard2.0"},
		{nugetDependencyAlias, nugetDependencyNet8},
		{nugetDependencyNet8, "NET8.0"},
		{nugetDependencyNet8, ""},
		{"targetFramework", "framework"},
		{"Microsoft.Extensions.Logging", "Other.Dependency"},
		{"range", pythonManifestVersion},
		{nugetDependencyVersion, "10.0.8"},
		{"\"10.0.9\"", nugetNullJSON},
		{"[10.0.9, )", "[10.0.9, 11.0.0)"},
		{`"dependencies":[`, `"dependencies":[{"id":"Other.Dependency","range":"1.2.3"},`},
		{`"dependencies":[`, `"dependencies":[{"id":"Microsoft.Extensions.Logging","range":"10.0.9"},`},
	} {
		data := strings.ReplaceAll(validGroups, change[0], change[1])
		value, decoded := decodeCheckDocument([]byte(data))
		if !decoded || contract.matchesGroups(value) {
			t.Fatal("contradictory or malformed catalog dependency groups accepted")
		}
	}
	for _, data := range []string{
		nugetNullJSON, `{}`, `[]`, `[null,null]`, `[{},{}]`,
		`[{"targetFramework":"net8.0","dependencies":[]}]`,
	} {
		value, decoded := decodeCheckDocument([]byte(data))
		if !decoded || contract.matchesGroups(value) {
			t.Fatal("incomplete catalog dependency groups accepted")
		}
	}
}

func TestNugetAdapterDependencyReferences(t *testing.T) {
	t.Parallel()
	project := strings.ReplaceAll(nugetDependencyFixture, nugetDependencyGroupEnd,
		`<ProjectReference Include="../LogBrew/LogBrew.csproj"/></ItemGroup>`)
	for _, coreRange := range []string{"", "latest"} {
		if nugetSourceDependencies([]byte(project), dotnetMetadataHTTP, coreRange) != nil {
			t.Fatal("invalid core dependency range accepted")
		}
	}
	for _, change := range [][2]string{
		{nugetCoreProject, "../Other/Other.csproj"},
		{nugetDependencyGroupEnd, `<ProjectReference Include="../LogBrew/LogBrew.csproj"/></ItemGroup>`},
		{nugetDependencyGroupEnd, `<PackageReference Include="LogBrew" Version="0.1.7"/></ItemGroup>`},
		{`ProjectReference Include`, `ProjectReference Condition="true" Include`},
	} {
		data := strings.ReplaceAll(project, change[0], change[1])
		if nugetSourceDependencies([]byte(data), dotnetMetadataHTTP, nugetDependencyCoreRange) != nil {
			t.Fatal("wrong, duplicate, shadowed or conditional core dependency accepted")
		}
	}
	data := []byte(nugetDependencyFixture + strings.Repeat(" ", nugetProjectLimit-len(nugetDependencyFixture)))
	if nugetSourceDependencies(data, dotnetMetadataCore, "") == nil {
		t.Fatal("source at the exact byte limit rejected")
	}
}

func TestNugetNuspecDependencies(t *testing.T) {
	t.Parallel()
	contract := nugetSourceDependencies([]byte(nugetDependencyFixture), dotnetMetadataCore, "")
	data := `<metadata><dependencies><group targetFramework=".NETStandard2.0">` +
		`<dependency id="Microsoft.Extensions.Logging" version="10.0.9"/></group>` +
		`<group targetFramework="net8.0"><dependency id="Microsoft.Extensions.Logging" version="[10.0.9, )"/>` +
		`</group></dependencies></metadata>`
	if !contract.matchesNuspec(parseMetadataXML([]byte(data))) {
		t.Fatal("source-matching nuspec dependencies rejected")
	}
	for _, change := range [][2]string{
		{"<dependencies>", "<dependencies/><dependencies>"},
		{"dependencies", "unexpected-element"},
		{"group", "unexpected-element"},
		{"<dependency ", "<other "},
		{nugetDependencyNet8, dotnetMetadataStandard},
		{"targetFramework", "framework"},
		{`version="10.0.9"`, `version="10.0.8"`},
		{"version=", "range="},
		{"</group>", `<dependency id="Other.Dependency" version="1.2.3"/></group>`},
		{`version="10.0.9"/>`, `version="10.0.9"><nested/></dependency>`},
	} {
		mutated := parseMetadataXML([]byte(strings.ReplaceAll(data, change[0], change[1])))
		if mutated == nil || contract.matchesNuspec(mutated) {
			t.Fatal("contradictory or unsupported nuspec dependency tree accepted")
		}
	}
	if contract.matchesNuspec(nil) {
		t.Fatal("missing nuspec metadata accepted")
	}
}
