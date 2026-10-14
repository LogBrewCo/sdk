package main

import (
	"bytes"
	"io"
	"maps"
	"path/filepath"
	"strings"
	"testing"
)

func TestRustReleaseMetadata(t *testing.T) {
	t.Parallel()
	manifest := repositorySource(t, rustMetadataManifest)
	readme := repositorySource(t, rustMetadataReadme)
	if !validRustMetadata([]byte(manifest), []byte(readme)) {
		t.Fatal("current Rust release metadata rejected")
	}
	for _, replacement := range [][2]string{
		{`name = "logbrew"`, `name = "unknown"`},
		{`version = "0.1.7"`, `version = "9.9.9"`},
		{`license = "MIT"`, `license = false`},
		{`readme = "README.md"`, `readme = "unknown.md"`},
		{`repository = "https://github.com/LogBrewCo/sdk"`, `repository = false`},
		{`keywords = ["logbrew"`, `keywords = ["unknown"`},
		{`description = "Public LogBrew`, `description = "Unknown`},
	} {
		changed := strings.Replace(manifest, replacement[0], replacement[1], 1)
		if changed == manifest || decodeReleaseMetadata([]byte(changed), "package") == nil ||
			validRustMetadata([]byte(changed), []byte(readme)) {
			t.Fatal("invalid Rust declaration accepted or mutation did not apply")
		}
	}
	for _, guidance := range []string{
		"Metrics", "MetricEvent", "client.metric", "low-cardinality",
		"OpenTelemetry Span Exporter", "opentelemetry-exporter",
	} {
		changed := strings.ReplaceAll(readme, guidance, "omitted")
		if changed == readme || validRustMetadata([]byte(manifest), []byte(changed)) {
			t.Fatal("missing Rust guidance accepted or mutation did not apply")
		}
	}
}

func TestReleaseMetadataCommand(t *testing.T) {
	t.Parallel()
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{"rust", root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != "{\"scope\":\"rust_release_metadata\",\"valid\":true}\n" {
		t.Fatal("Rust command receipt invalid")
	}
	for _, arguments := range [][]string{
		nil, {areaRust}, {fixtureUnknown, root}, {areaRust, "relative-repository"}, {areaRust, root, root},
	} {
		if runReleaseMetadata(arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid metadata selection accepted")
		}
	}
}

func TestRustMetadataRejectsInvalidDocuments(t *testing.T) {
	t.Parallel()
	manifest := []byte(repositorySource(t, rustMetadataManifest))
	readme := []byte(repositorySource(t, rustMetadataReadme))
	for _, data := range []string{
		"", "[package", "package = 42", "[package]\nname='\xff'",
		string(manifest) + "\n[package]\n", strings.Repeat(" ", pythonManifestLimit+1),
	} {
		if validRustMetadata([]byte(data), readme) {
			t.Fatal("malformed or oversized Rust manifest accepted")
		}
	}
	for _, data := range [][]byte{
		nil, []byte(string(readme) + "\xff"), bytes.Repeat([]byte("x"), pythonManifestLimit+1),
	} {
		if validRustMetadata(manifest, data) {
			t.Fatal("missing, malformed, or oversized Rust guidance accepted")
		}
	}
}

func TestRustMetadataRequiresBothFiles(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		rustMetadataManifest: repositorySource(t, rustMetadataManifest),
		rustMetadataReadme:   repositorySource(t, rustMetadataReadme),
	}
	assertReleaseMetadataFiles(t, areaRust, files)
}

func assertReleaseMetadataFiles(t *testing.T, family string, files map[string]string) {
	t.Helper()
	root := confidentialityFixture(t, files)
	var output, diagnostic bytes.Buffer
	if runReleaseMetadata([]string{family, root}, &output, &diagnostic) != exitOK || diagnostic.Len() != 0 ||
		output.String() != `{"scope":"`+family+`_release_metadata","valid":true}`+"\n" {
		t.Fatalf("complete %s metadata fixture rejected or receipt invalid", family)
	}
	for missing := range files {
		remaining := maps.Clone(files)
		delete(remaining, missing)
		root = confidentialityFixture(t, remaining)
		output.Reset()
		diagnostic.Reset()
		if runReleaseMetadata([]string{family, root}, &output, &diagnostic) != exitFailure ||
			output.Len() != 0 || diagnostic.Len() == 0 || strings.Contains(diagnostic.String(), root) {
			t.Fatalf("missing %s accepted or diagnostic exposed input path", missing)
		}
	}
}
