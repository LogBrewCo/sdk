package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	nugetArtifactBranch          = "main"
	nugetArtifactFloatingVersion = "latest"
	nugetArtifactHTTPVersion     = "0.1.2"
	nugetArtifactIDXML           = "<id>LogBrew</id>"
	nugetArtifactNuspec          = "LogBrew.nuspec"
	nugetArtifactCommit          = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	nugetArtifactVersion         = "0.1.7"
	nugetArtifactDocument        = `<package><metadata><id>LogBrew</id><version>0.1.7</version>` +
		`<repository type="git" url="https://github.com/LogBrewCo/sdk" commit="` + nugetArtifactCommit + `"/>` +
		`<dependencies><group targetFramework=".NETStandard2.0">` +
		`<dependency id="Microsoft.Extensions.Logging" version="10.0.9"/></group>` +
		`<group targetFramework="net8.0"><dependency id="Microsoft.Extensions.Logging" version="[10.0.9, )"/>` +
		`</group></dependencies></metadata></package>`
)

func nugetArtifactFixture() *nugetArtifactSpec {
	return &nugetArtifactSpec{
		id: dotnetMetadataCore, version: nugetArtifactVersion, sourceCommit: nugetArtifactCommit,
		dependencies: nugetSourceDependencies([]byte(nugetDependencyFixture), dotnetMetadataCore, ""),
	}
}

func TestNugetArtifactIdentity(t *testing.T) {
	t.Parallel()
	spec := nugetArtifactFixture()
	for _, document := range []string{
		nugetArtifactDocument,
		strings.Replace(nugetArtifactDocument, "<package>", `<package xmlns="urn:package-metadata">`, 1),
	} {
		entries := make([]pythonArchiveEntry, 0, 3)
		entries = append(entries, pythonFixtureFile(nugetArtifactNuspec, document),
			pythonFixtureFile("lib/net8.0/LogBrew.dll", "synthetic-assembly"))
		data := pythonFixtureZip(t, entries)
		expected, readable := nugetPackageContentSHA256(data)
		actual, valid := spec.contentSHA256(data)
		if !readable || !valid || actual != expected {
			t.Fatal("source-bound package content rejected or digest changed")
		}
		entries = append(entries, pythonFixtureFile(".signature.p7s", "synthetic-signature"))
		slices.Reverse(entries)
		actual, valid = spec.contentSHA256(pythonFixtureZip(t, entries))
		if !valid || actual != expected {
			t.Fatal("signature or archive order changed source-bound content identity")
		}
	}
}

func TestNugetArtifactRejectsIdentityDrift(t *testing.T) {
	t.Parallel()
	spec := nugetArtifactFixture()
	for _, change := range [][2]string{
		{nugetArtifactIDXML, "<id>Other</id>"},
		{nugetArtifactVersion, "0.1.8"},
		{nugetArtifactCommit, strings.Repeat("b", pythonSourceCommitSize)},
		{`type="git"`, `type="other"`},
		{releaseMetadataRepository, "https://example.com/sdk"},
		{"<metadata>", "<metadata/><metadata>"},
		{"<repository ", "<repository/><repository "},
		{nugetArtifactIDXML, "<id>LogBrew</id><id>LogBrew</id>"},
		{nugetArtifactIDXML, "<id>LogBrew<extra/></id>"},
		{"<id>", `<id xmlns="urn:other">`},
		{"<package>", "<!DOCTYPE package><package>"},
		{"package>", "other>"},
		{"metadata>", "other>"},
		{`commit="` + nugetArtifactCommit + `"`, ""},
		{"10.0.9", "10.0.8"},
	} {
		data := pythonFixtureZip(t, []pythonArchiveEntry{
			pythonFixtureFile(nugetArtifactNuspec, strings.ReplaceAll(nugetArtifactDocument, change[0], change[1])),
		})
		if digest, valid := spec.contentSHA256(data); valid || digest != "" {
			t.Fatal("wrong or ambiguous package provenance accepted")
		}
	}
}

func TestNugetArtifactRejectsMissingOrOversizedMetadata(t *testing.T) {
	t.Parallel()
	spec := nugetArtifactFixture()
	for _, entries := range [][]pythonArchiveEntry{
		{pythonFixtureFile("README.md", "no metadata")},
		{pythonFixtureFile(nugetArtifactNuspec, "")},
		{
			pythonFixtureFile(nugetArtifactNuspec, nugetArtifactDocument),
			pythonFixtureFile("Other.nuspec", nugetArtifactDocument),
		},
		{pythonFixtureFile(nugetArtifactNuspec, strings.Repeat(" ", nugetProjectLimit)+nugetArtifactDocument)},
	} {
		if _, valid := spec.contentSHA256(pythonFixtureZip(t, entries)); valid {
			t.Fatal("missing, duplicate or oversized package metadata accepted")
		}
	}
	if _, valid := spec.contentSHA256([]byte("not a package")); valid {
		t.Fatal("invalid archive accepted")
	}
	document := nugetArtifactDocument + strings.Repeat(" ", nugetProjectLimit-len(nugetArtifactDocument))
	if _, valid := spec.contentSHA256(pythonFixtureZip(t,
		[]pythonArchiveEntry{pythonFixtureFile(nugetArtifactNuspec, document)})); !valid {
		t.Fatal("exact nuspec size boundary rejected")
	}
}

func TestNugetArtifactRejectsInvalidSelection(t *testing.T) {
	t.Parallel()
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(nugetArtifactNuspec, nugetArtifactDocument)})
	for _, mutate := range []func(*nugetArtifactSpec){
		func(spec *nugetArtifactSpec) { spec.id = fixtureUnknown },
		func(spec *nugetArtifactSpec) { spec.version = nugetArtifactFloatingVersion },
		func(spec *nugetArtifactSpec) { spec.sourceCommit = nugetArtifactBranch },
		func(spec *nugetArtifactSpec) { spec.sourceCommit = strings.ToUpper(nugetArtifactCommit) },
		func(spec *nugetArtifactSpec) { spec.dependencies = nil },
	} {
		spec := nugetArtifactFixture()
		mutate(spec)
		if digest, valid := spec.contentSHA256(data); valid || digest != "" {
			t.Fatal("invalid selected package identity accepted")
		}
	}
	var absent *nugetArtifactSpec
	if _, valid := absent.contentSHA256(data); valid {
		t.Fatal("missing selected package identity accepted")
	}
}

func TestNugetSourceDependencyFiles(t *testing.T) {
	t.Parallel()
	const projectPath = dotnetMetadataSource + "LogBrew/LogBrew.csproj"
	directory := confidentialityFixture(t, map[string]string{projectPath: nugetDependencyFixture})
	if readNugetSourceDependencies(directory, dotnetMetadataCore, "") == nil {
		t.Fatal("bounded canonical source file rejected")
	}
	for _, invalid := range []string{
		"", ".", filepath.Join(directory, "missing"), filepath.Join(directory, projectPath),
	} {
		if readNugetSourceDependencies(invalid, dotnetMetadataCore, "") != nil {
			t.Fatal("invalid source root accepted")
		}
	}
	if readNugetSourceDependencies(directory, "../LogBrew", "") != nil {
		t.Fatal("unselected source project accepted")
	}
	alias := filepath.Join(t.TempDir(), "source-alias")
	if err := os.Symlink(directory, alias); err != nil {
		t.Fatal(err)
	}
	if readNugetSourceDependencies(alias, dotnetMetadataCore, "") != nil {
		t.Fatal("symlink source root accepted")
	}
	filename := filepath.Join(directory, projectPath)
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	outside := confidentialityFixture(t, map[string]string{"project.csproj": nugetDependencyFixture})
	if err := os.Symlink(filepath.Join(outside, "project.csproj"), filename); err != nil {
		t.Fatal(err)
	}
	if readNugetSourceDependencies(directory, dotnetMetadataCore, "") != nil {
		t.Fatal("symlink source project accepted")
	}
}

func TestNugetArtifactHTTPSourceBinding(t *testing.T) {
	t.Parallel()
	const projectPath = dotnetMetadataSource + "LogBrew.HttpClient/LogBrew.HttpClient.csproj"
	directory := confidentialityFixture(t, map[string]string{projectPath: repositorySource(t, projectPath)})
	spec := &nugetArtifactSpec{
		id: dotnetMetadataHTTP, version: nugetArtifactHTTPVersion, sourceCommit: nugetArtifactCommit,
		dependencies: readNugetSourceDependencies(directory, dotnetMetadataHTTP, nugetDependencyCoreRange),
	}
	document := strings.NewReplacer(
		nugetArtifactIDXML, "<id>LogBrew.HttpClient</id>", "<version>0.1.7</version>", "<version>0.1.2</version>",
		"Microsoft.Extensions.Logging", "Microsoft.Extensions.Http",
		"</group>", `<dependency id="LogBrew" version="[0.1.7, 0.2.0)"/></group>`,
	).Replace(nugetArtifactDocument)
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile("LogBrew.HttpClient.nuspec", document)})
	if _, valid := spec.contentSHA256(data); !valid {
		t.Fatal("HTTP package rejected despite matching source and core dependency")
	}
	mutated := strings.ReplaceAll(document, nugetDependencyCoreRange, "[0.1.6, 0.2.0)")
	if _, valid := spec.contentSHA256(pythonFixtureZip(t,
		[]pythonArchiveEntry{pythonFixtureFile("LogBrew.HttpClient.nuspec", mutated)})); valid {
		t.Fatal("HTTP package core dependency drift accepted")
	}
}
