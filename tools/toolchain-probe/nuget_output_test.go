//go:build darwin || linux

package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const (
	nugetOutputExistingDirectory = "directory"
	nugetOutputExistingFile      = "file"
	nugetOutputExistingSymlink   = "existing-symlink"
)

func nugetOutputFixture(t *testing.T) []nugetResolvedPackage {
	t.Helper()
	core := nugetArtifactFixture()
	project := repositorySource(t, dotnetMetadataSource+"LogBrew.HttpClient/LogBrew.HttpClient.csproj")
	httpSpec := &nugetArtifactSpec{
		id: dotnetMetadataHTTP, version: nugetArtifactHTTPVersion, sourceCommit: nugetArtifactCommit,
		dependencies: nugetSourceDependencies([]byte(project), dotnetMetadataHTTP,
			nugetDependencyCoreRange),
	}
	httpDocument := strings.NewReplacer(
		nugetArtifactIDXML, "<id>LogBrew.HttpClient</id>", "<version>0.1.7</version>", "<version>0.1.2</version>",
		nugetRegistryLogging, "Microsoft.Extensions.Http",
		"</group>", `<dependency id="LogBrew" version="[0.1.7, 0.2.0)"/></group>`,
	).Replace(nugetArtifactDocument)
	packages := make([]nugetResolvedPackage, 0, 2)
	for index, spec := range []*nugetArtifactSpec{core, httpSpec} {
		document := []string{nugetArtifactDocument, httpDocument}[index]
		data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(spec.id+".nuspec", document)})
		digest := sha256.Sum256(data)
		registry := sha512.Sum512(data)
		content, valid := spec.contentSHA256(data)
		if !valid {
			t.Fatal("NuGet output fixture is not source-bound")
		}
		packages = append(packages, nugetResolvedPackage{spec: spec, artifact: &nugetPublicArtifact{
			data: data, sha256: hex.EncodeToString(digest[:]), contentSHA256: content,
			registrySHA512: base64.StdEncoding.EncodeToString(registry[:]),
		}})
	}
	return packages
}

func TestNugetOutputPublishesCompleteBundle(t *testing.T) {
	t.Parallel()
	packages := nugetOutputFixture(t)
	parent := t.TempDir()
	destination := filepath.Join(parent, "public")
	if !writeNugetPublicBundle(destination, packages) {
		t.Fatal("verified NuGet bundle did not publish")
	}
	records := readNugetOutputRecords(t, destination)
	for index, item := range packages {
		assertNugetOutputRecord(t, filepath.Join(destination, nugetPublicPackageDirectory), item, records[index])
	}
	if writeNugetPublicBundle(destination, packages) {
		t.Fatal("NuGet output replaced an existing bundle")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 {
		t.Fatal("NuGet output left staging files")
	}
	files, err := os.ReadDir(destination)
	if err != nil || len(files) != 2 {
		t.Fatal("NuGet bundle includes unexpected files")
	}
	artifacts, err := os.ReadDir(filepath.Join(destination, nugetPublicPackageDirectory))
	if err != nil || len(artifacts) != len(packages) {
		t.Fatal("NuGet feed does not contain exactly the selected packages")
	}
}

func readNugetOutputRecords(t *testing.T, directory string) []any {
	t.Helper()
	data, readable := readCheckFile(filepath.Join(directory, nugetPublicManifestName))
	document, decoded := decodeCheckDocument(data)
	manifest := eventObject(document)
	if !readable || !decoded || len(manifest) != 3 || manifest[pythonManifestSchemaKey] != json.Number("1") ||
		manifest[pythonManifestCommitKey] != nugetArtifactCommit {
		t.Fatal("NuGet manifest identity changed")
	}
	records, valid := manifest[pythonManifestPackages].([]any)
	if !valid || len(records) != 2 {
		t.Fatal("NuGet package receipt count changed")
	}
	return records
}

func assertNugetOutputRecord(t *testing.T, directory string, item nugetResolvedPackage, record any) {
	t.Helper()
	name := item.spec.id + "." + item.spec.version + ".nupkg"
	expected := map[string]any{
		"id": item.spec.id, pythonManifestVersion: item.spec.version, pythonManifestFile: name,
		pythonManifestHash: item.artifact.sha256, "registrySha512": item.artifact.registrySHA512,
		pythonPublicContentHash: item.artifact.contentSHA256,
	}
	actual, present := readCheckFile(filepath.Join(directory, name))
	if !present || !bytes.Equal(actual, item.artifact.data) || !reflect.DeepEqual(record, expected) {
		t.Fatal("NuGet package bytes or receipt fields changed")
	}
	info, err := os.Stat(filepath.Join(directory, name))
	if err != nil || info.Mode().Perm() != pythonTemporaryFileMode {
		t.Fatal("NuGet output permission differs")
	}
}

func TestNugetOutputRejectsIncompleteEvidence(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{
		"missing-package", "order", "nil-spec", "nil-artifact", "different-source", "core-range",
		"package-bytes", "full-hash", "registry-hash", "content-hash",
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			packages := mutateNugetOutput(t, nugetOutputFixture(t), mutation)
			parent := t.TempDir()
			if writeNugetPublicBundle(filepath.Join(parent, "public"), packages) {
				t.Fatal("invalid NuGet evidence was published")
			}
			entries, err := os.ReadDir(parent)
			if err != nil || len(entries) != 0 {
				t.Fatal("rejected NuGet evidence changed output")
			}
		})
	}
}

func mutateNugetOutput(t *testing.T, packages []nugetResolvedPackage, mutation string) []nugetResolvedPackage {
	t.Helper()
	switch mutation {
	case "missing-package":
		return packages[:1]
	case "order":
		packages[0], packages[1] = packages[1], packages[0]
	case "nil-spec":
		packages[0].spec = nil
	case "nil-artifact":
		packages[1].artifact = nil
	case "different-source":
		packages[1].spec.sourceCommit = strings.Repeat("b", pythonSourceCommitSize)
	case "core-range":
		packages[1].spec.dependencies.dependencies[dotnetMetadataCore] = "[0.1.6, 0.2.0)"
	case "package-bytes":
		packages[0].artifact.data = append(packages[0].artifact.data, 'x')
	case "full-hash":
		packages[0].artifact.sha256 = strings.Repeat("a", pythonArtifactHashSize)
	case "registry-hash":
		packages[0].artifact.registrySHA512 = "malformed-nuget-digest"
	case "content-hash":
		packages[0].artifact.contentSHA256 = strings.Repeat("a", pythonArtifactHashSize)
	default:
		t.Fatal("unknown NuGet output mutation")
	}
	return packages
}

func TestReleaseBundleWriteFailureLeavesNoPartialOutput(t *testing.T) {
	t.Parallel()
	parent := t.TempDir()
	if writeReleaseBundle(filepath.Join(parent, "public"), func(root *os.Root) bool {
		if !createVerifiedReleaseOutput(root, "first.nupkg", []byte("synthetic-package"), pythonTemporaryFileMode) {
			t.Fatal("first staged write failed")
		}
		return createVerifiedReleaseOutput(root, "missing/manifest.json", []byte("{}"), pythonTemporaryFileMode)
	}) {
		t.Fatal("failed manifest write published a bundle")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("failed manifest write left partial packages or staging")
	}
}

func TestNugetOutputPreservesExistingDestinations(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{nugetOutputExistingDirectory, nugetOutputExistingFile, nugetOutputExistingSymlink} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			parent := t.TempDir()
			destination := filepath.Join(parent, "public")
			createExistingPublication(t, kind, destination)
			before, err := os.Lstat(destination)
			if err != nil || writeNugetPublicBundle(destination, nugetOutputFixture(t)) {
				t.Fatal("NuGet bundle replaced an existing destination")
			}
			after, err := os.Lstat(destination)
			if err != nil || !os.SameFile(before, after) {
				t.Fatal("existing destination identity changed")
			}
			entries, err := os.ReadDir(parent)
			if err != nil || len(entries) != 1 {
				t.Fatal("existing destination caused leftover staging")
			}
		})
	}
}

func TestReleaseOutputSupportsNugetByteLimit(t *testing.T) {
	t.Parallel()
	root := publishFixtureRoot(t, t.TempDir())
	// NuGet packages may exceed the generic JSON/receipt limit. This test
	// verifies the output writer, not the validity of these synthetic bytes.
	data := bytes.Repeat([]byte{'x'}, maximumOutputFile+1)
	if !createVerifiedReleaseOutput(root, "large.nupkg", data, pythonTemporaryFileMode) {
		t.Fatal("release writer rejected bytes below the NuGet package limit")
	}
	actual, readable := readNugetRootReceipt(root, "large.nupkg", nugetPackageLimit)
	if !readable || !bytes.Equal(actual, data) {
		t.Fatal("large release output lost exact readback")
	}
}
