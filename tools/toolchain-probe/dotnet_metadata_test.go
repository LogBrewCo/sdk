package main

import (
	"bytes"
	"io"
	"maps"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const dotnetMetadataReceipt = "{\"scope\":\"dotnet_release_metadata\",\"valid\":true}\n"

func TestDotnetMetadataCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{"dotnet", root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != dotnetMetadataReceipt {
		t.Fatal("current .NET metadata rejected or receipt invalid")
	}
}

func dotnetMetadataFixture(t *testing.T) map[string]string {
	t.Helper()
	files := make(map[string]string)
	for _, policy := range dotnetMetadataPolicies(nil) {
		for _, name := range policy.source.files {
			files[name] = ""
		}
		for manifest := range policy.source.text {
			files[manifest] = repositorySource(t, manifest)
		}
	}
	return files
}

func TestDotnetMetadataRequiredFiles(t *testing.T) {
	t.Parallel()
	const requiredFiles = 29
	files := dotnetMetadataFixture(t)
	if len(files) != requiredFiles {
		t.Fatal(".NET required file inventory changed")
	}
	assertReleaseMetadataFiles(t, dotnetMetadataFamily, files)
}

func TestDotnetMetadataDeclarations(t *testing.T) {
	t.Parallel()
	const normalFields, httpFields = 10, 13
	for id, policy := range dotnetMetadataPolicies(nil) {
		expectedFields := normalFields
		if id == dotnetMetadataHTTP {
			expectedFields = httpFields
		}
		if len(policy.fields) != expectedFields {
			t.Fatal(".NET field inventory changed")
		}
		for manifest, phrases := range policy.source.text {
			data := repositorySource(t, manifest)
			description := dotnetProjectProperties([]byte(data)).value("Description")
			assertDotnetFieldMutations(t, policy, data, "Description", description)
			for name, value := range policy.fields {
				assertDotnetFieldMutations(t, policy, data, name, value)
			}
			assertMetadataPhrases(t, data, phrases)
		}
	}
}

func assertDotnetFieldMutations(t *testing.T, policy dotnetMetadataPolicy, data, name, value string) {
	t.Helper()
	field := "<" + name + ">" + value + "</" + name + ">"
	if name == "IsAotCompatible" {
		field = `<IsAotCompatible Condition="'$(TargetFramework)' == 'net8.0'">true</IsAotCompatible>`
	}
	for _, replacement := range []string{"", field + field, strings.Replace(field, value, fixtureUnknown, 1)} {
		changed := strings.Replace(data, field, replacement, 1)
		if changed == data || policy.valid([]byte(changed)) {
			t.Fatalf(".NET metadata field %s accepted an invalid mutation", name)
		}
	}
}

func TestDotnetMetadataCatalog(t *testing.T) {
	t.Parallel()
	const otherPackage = "Other"
	files := dotnetMetadataFixture(t)
	for _, test := range []struct {
		id, extra string
		valid     bool
	}{
		{otherPackage, "", false},
		{dotnetMetadataCore, "", false},
		{"", "", false},
		{otherPackage, "<IsPackable>false</IsPackable>", true},
		{otherPackage, "<IsPackable>FALSE</IsPackable>", true},
		{otherPackage, "<IsPackable>true</IsPackable>", false},
	} {
		fixture := maps.Clone(files)
		fixture[dotnetMetadataSource+"Extra/Extra.csproj"] = "<Project><PropertyGroup><PackageId>" +
			test.id + "</PackageId>" + test.extra + "</PropertyGroup></Project>"
		root := confidentialityFixture(t, fixture)
		result := runReleaseMetadata([]string{dotnetMetadataFamily, root}, io.Discard, io.Discard)
		if (result == exitOK) != test.valid {
			t.Fatal(".NET catalog failed to distinguish omitted, duplicated, and nonpackable projects")
		}
	}
}

func TestDotnetMetadataInventoryBounds(t *testing.T) {
	t.Parallel()
	files := dotnetMetadataFixture(t)
	for index := range dotnetMetadataInventoryLimit + 1 {
		files[dotnetMetadataSource+dotnetMetadataCore+"/extra-"+strconv.Itoa(index)] = ""
	}
	root := confidentialityFixture(t, files)
	if runReleaseMetadata([]string{dotnetMetadataFamily, root}, io.Discard, io.Discard) != exitFailure {
		t.Fatal("oversized .NET source inventory accepted")
	}
}

func TestDotnetMetadataVersions(t *testing.T) {
	t.Parallel()
	for version, expected := range map[string]string{
		pythonFixtureVersion: "[0.1.5, 0.2.0)", "1.2.3": "[1.2.3, 2.0.0)",
		"0.9.1-preview.1": "[0.9.1-preview.1, 0.10.0)", fixtureUnknown: "", "1.2": "",
	} {
		if dotnetCompatibleRange(version) != expected {
			t.Fatal(".NET compatible dependency range changed")
		}
	}
	for _, versions := range []map[string]string{
		{fixtureUnknown: "1.2.3"},
		{dotnetMetadataCore: fixtureUnknown},
		{dotnetMetadataCore: "999999999999999999.1.0"},
	} {
		if dotnetMetadataPolicies(versions) != nil {
			t.Fatal("unknown or invalid .NET version override accepted")
		}
	}
	files := dotnetMetadataFixture(t)
	core := dotnetMetadataSource + "LogBrew/LogBrew.csproj"
	http := dotnetMetadataSource + "LogBrew.HttpClient/LogBrew.HttpClient.csproj"
	files[core] = strings.Replace(files[core], "<Version>0.1.7</Version>", "<Version>0.1.5</Version>", 1)
	files[http] = strings.Replace(files[http], "[0.1.7, 0.2.0)", "[0.1.5, 0.2.0)", 1)
	root, err := os.OpenRoot(confidentialityFixture(t, files))
	if err != nil {
		t.Fatal(err)
	}
	defaultValid := checkDotnetMetadata(root)
	versions := map[string]string{dotnetMetadataCore: pythonFixtureVersion}
	overrideValid := checkDotnetMetadataPolicies(root, dotnetMetadataPolicies(versions))
	var output, diagnostic bytes.Buffer
	arguments := []string{dotnetMetadataFamily, root.Name(), dotnetMetadataCore + "=" + pythonFixtureVersion}
	code := runReleaseMetadata(arguments, &output, &diagnostic)
	if closeError := root.Close(); defaultValid || !overrideValid || closeError != nil {
		t.Fatal(".NET version override failed to bind both core and dependency range")
	}
	if code != exitOK || diagnostic.Len() != 0 || output.String() != dotnetMetadataReceipt {
		t.Fatal(".NET command did not preserve the selected version override")
	}
}

func TestDotnetMetadataPackabilityShape(t *testing.T) {
	t.Parallel()
	for _, value := range []string{
		"<IsPackable>false</IsPackable><IsPackable>true</IsPackable>",
		"<IsPackable>false<nested/></IsPackable>", "<IsPackable/>",
	} {
		data := "<Project><PropertyGroup>" + value + "</PropertyGroup></Project>"
		if dotnetProjectProperties([]byte(data)) != nil {
			t.Fatal("ambiguous .NET packability accepted")
		}
	}
}

func TestDotnetMetadataOverrideArguments(t *testing.T) {
	t.Parallel()
	const assignment = "="
	root := t.TempDir()
	valid := dotnetMetadataCore + assignment + pythonFixtureVersion
	for _, overrides := range [][]string{
		{dotnetMetadataCore},
		{dotnetMetadataCore + assignment},
		{fixtureUnknown + assignment + pythonFixtureVersion},
		{valid, valid},
		{dotnetMetadataCore + assignment + fixtureUnknown},
		{valid, valid, valid, valid, valid, valid, valid, valid},
	} {
		arguments := append([]string{dotnetMetadataFamily, root}, overrides...)
		var output, diagnostic bytes.Buffer
		if runReleaseMetadata(arguments, &output, &diagnostic) != exitUsage || output.Len() != 0 ||
			diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), root) {
			t.Fatal("invalid .NET version arguments accepted or input reflected")
		}
	}
}

func TestDotnetMetadataNamespaces(t *testing.T) {
	t.Parallel()
	for _, policy := range dotnetMetadataPolicies(nil) {
		for manifest := range policy.source.text {
			data := repositorySource(t, manifest)
			qualified := strings.Replace(data, "<Project ", `<Project xmlns="`+dotnetMetadataNamespace+`" `, 1)
			if !policy.valid([]byte(qualified)) {
				t.Fatal("standard MSBuild namespace rejected")
			}
			changed := strings.Replace(qualified, dotnetMetadataNamespace, "urn:other", 1)
			if policy.valid([]byte(changed)) {
				t.Fatal("unknown .NET metadata namespace accepted")
			}
		}
	}
}
