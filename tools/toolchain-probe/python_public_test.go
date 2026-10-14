package main

import (
	"bytes"
	"encoding/json"
	"path"
	"strings"
	"testing"
)

const (
	pythonPublicFixtureVersion  = "0.1.4"
	pythonPublicMissingArtifact = "missing-artifact"
)

func pythonPublicFixture(tb testing.TB) []byte {
	tb.Helper()
	files := make([]any, 0, 2)
	for _, kind := range []string{pythonWheel, pythonSdist} {
		name := path.Base(pythonReleaseArtifactPath(pythonReleaseCatalog()[0], pythonPublicFixtureVersion, kind))
		packageType := pythonSdist
		if kind == pythonWheel {
			packageType = pythonPublicType
		}
		files = append(files, map[string]any{
			pythonPublicFilename: name, "packagetype": packageType,
			pythonPublicURL: "https://files.pythonhosted.org/packages/example/" + name,
			"digests":       map[string]any{pythonManifestHash: strings.Repeat("a", 64)},
		})
	}
	return pythonManifestJSON(tb, map[string]any{
		"info":           map[string]any{pythonPublicName: "logbrew-sdk", "version": pythonPublicFixtureVersion},
		pythonPublicURLs: files,
	})
}

func TestPythonPublicMetadataRequiresExactArtifactSet(t *testing.T) {
	t.Parallel()
	data := pythonPublicFixture(t)
	spec := pythonReleaseCatalog()[0]
	records, valid := parsePythonPublicMetadata(data, spec, pythonPublicFixtureVersion)
	if !valid || len(records) != 2 || records[pythonWheel].url !=
		"https://files.pythonhosted.org/packages/example/logbrew_sdk-0.1.4-py3-none-any.whl" {
		t.Fatal("exact public artifact inventory rejected")
	}
	for _, kind := range []string{pythonWheel, pythonSdist} {
		if records[kind].sha256 != strings.Repeat("a", 64) {
			t.Fatal("public artifact digest changed")
		}
	}
	for _, mutation := range []string{
		"wrong-name", "wrong-version", "no-info", "no-files", pythonPublicMissingArtifact,
		"extra-artifact-row", "duplicate",
		pythonPublicFilename, "type", "hash", "numeric-hash", pythonPublicURL, "not-an-object",
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			mutated := pythonManifestObject(t, data)
			mutatePythonPublicMetadata(t, mutated, mutation)
			if _, accepted := parsePythonPublicMetadata(pythonManifestJSON(t, mutated), spec,
				pythonPublicFixtureVersion); accepted {
				t.Fatal("invalid public artifact metadata accepted")
			}
		})
	}
	for _, invalid := range [][]byte{
		[]byte("{"), []byte("null"), bytes.Repeat([]byte(" "), pythonManifestLimit+1),
		bytes.Replace(data, []byte(`"info":`), []byte(`"info":null,"info":`), 1),
	} {
		if _, accepted := parsePythonPublicMetadata(invalid, spec, pythonPublicFixtureVersion); accepted {
			t.Fatal("invalid public JSON accepted")
		}
	}
}

func mutatePythonPublicMetadata(t *testing.T, document map[string]any, mutation string) {
	t.Helper()
	info, valid := document["info"].(map[string]any)
	files, array := document[pythonPublicURLs].([]any)
	if !valid || !array || len(files) != 2 {
		t.Fatal("public metadata fixture failed")
	}
	file, valid := files[0].(map[string]any)
	if !valid {
		t.Fatal("public artifact fixture failed")
	}
	switch mutation {
	case "wrong-name":
		info[pythonPublicName] = pythonFixturePackage
	case "wrong-version":
		info["version"] = "9.9.9"
	case "no-info":
		document["info"] = nil
	case "no-files":
		document[pythonPublicURLs] = nil
	case pythonPublicMissingArtifact:
		document[pythonPublicURLs] = files[:1]
	case "extra-artifact-row":
		document[pythonPublicURLs] = append(files, files[0])
	case "duplicate":
		files[1] = files[0]
	case "not-an-object":
		files[0] = nil
	default:
		mutatePythonPublicFile(t, file, mutation)
	}
}

func mutatePythonPublicFile(t *testing.T, file map[string]any, mutation string) {
	t.Helper()
	switch mutation {
	case pythonPublicFilename:
		file[pythonPublicFilename] = "unexpected.whl"
	case "type":
		file["packagetype"] = pythonSdist
	case "hash":
		file["digests"] = map[string]any{pythonManifestHash: strings.Repeat("A", 64)}
	case "numeric-hash":
		file["digests"] = map[string]any{pythonManifestHash: json.Number(strings.Repeat("1", 64))}
	case pythonPublicURL:
		file[pythonPublicURL] = "https://example.test/other.whl"
	default:
		t.Fatal("unknown metadata mutation")
	}
}

func TestPythonPublicURLRejectsAlternateDestinations(t *testing.T) {
	t.Parallel()
	filename := "logbrew_sdk-0.1.4-py3-none-any.whl"
	prefix := "https://files.pythonhosted.org/"
	if !validPythonPublicURL(prefix+"packages/example/"+filename, filename) {
		t.Fatal("canonical file URL rejected")
	}
	for _, address := range []string{
		"http://files.pythonhosted.org/" + filename,
		"https://files.pythonhosted.org.example.test/" + filename,
		"https://files.pythonhosted.org:443/" + filename,
		"https://user@files.pythonhosted.org/" + filename,
		prefix + "packages/../" + filename,
		prefix + "packages/%2e%2e/" + filename,
		prefix + "packages/./" + filename,
		prefix + "/" + filename,
		prefix + filename + "?", prefix + filename + "#",
		prefix + filename + "?token=example", prefix + filename + "#fragment",
		prefix + "wrong.whl", prefix + "\\" + filename, prefix + "\n" + filename,
	} {
		if validPythonPublicURL(address, filename) {
			t.Fatal("alternate or ambiguous public file URL accepted")
		}
	}
}
