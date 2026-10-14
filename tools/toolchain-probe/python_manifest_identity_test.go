package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

const pythonManifestExtraField = "extra"

func pythonManifestJSON(tb testing.TB, document any) []byte {
	tb.Helper()
	data, err := json.Marshal(document)
	if err != nil {
		tb.Fatal(err)
	}
	return data
}

func pythonManifestObject(tb testing.TB, data []byte) map[string]any {
	tb.Helper()
	document, valid := decodeCheckDocument(data)
	object, isObject := document.(map[string]any)
	if !valid || !isObject {
		tb.Fatal("fixture is not a JSON object")
	}
	return object
}

func pythonManifestEntry(tb testing.TB, document map[string]any) map[string]any {
	tb.Helper()
	entries, isArray := document[pythonManifestPackages].([]any)
	if !isArray || len(entries) != 4 {
		tb.Fatal("fixture packages missing")
	}
	entry, isObject := entries[0].(map[string]any)
	if !isObject {
		tb.Fatal("fixture package is not an object")
	}
	return entry
}

func TestPythonManifestRejectsInvalidIdentity(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	document := pythonFixtureManifest(t, directory, selection)
	data := pythonManifestJSON(t, document)
	for _, test := range []struct {
		value any
		field string
	}{
		{true, pythonManifestSchemaKey},
		{json.Number("1.0"), pythonManifestSchemaKey},
		{json.Number("1e0"), pythonManifestSchemaKey},
		{nil, pythonManifestSchemaKey},
		{strings.Repeat("A", pythonSourceCommitSize), pythonManifestCommitKey},
		{"../commit", pythonManifestCommitKey},
		{nil, pythonManifestPackages},
		{[]any{}, pythonManifestPackages},
		{true, "unknown"},
	} {
		mutated := pythonManifestObject(t, data)
		mutated[test.field] = test.value
		if checkPythonReleaseManifest(pythonManifestJSON(t, mutated), selection) {
			t.Errorf("accepted invalid %s", test.field)
		}
	}
	for _, field := range []string{pythonManifestSchemaKey, pythonManifestCommitKey, pythonManifestPackages} {
		mutated := pythonManifestObject(t, data)
		delete(mutated, field)
		if checkPythonReleaseManifest(pythonManifestJSON(t, mutated), selection) {
			t.Errorf("accepted missing %s", field)
		}
	}
	for _, invalid := range [][]byte{
		[]byte("null"), []byte("[]"), append(bytes.Clone(data), []byte("{}")...),
		bytes.Replace(data, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1),
		bytes.Replace(data, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schema\u0056ersion":1`), 1),
		bytes.Repeat([]byte(" "), pythonManifestLimit+1),
	} {
		if checkPythonReleaseManifest(invalid, selection) {
			t.Error("accepted malformed, oversized, duplicate-key, or non-object manifest")
		}
	}
}

func TestPythonManifestRejectsPackageSubstitution(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	document := pythonFixtureManifest(t, directory, selection)
	data := pythonManifestJSON(t, document)
	for _, test := range []struct {
		value any
		field string
	}{
		{"logbrew-flask", "id"},
		{1, pythonManifestVersion},
		{"../escape", pythonManifestVersion},
		{nil, pythonWheel},
		{nil, pythonSdist},
		{true, pythonManifestExtraField},
	} {
		mutated := pythonManifestObject(t, data)
		pythonManifestEntry(t, mutated)[test.field] = test.value
		if checkPythonReleaseManifest(pythonManifestJSON(t, mutated), selection) {
			t.Errorf("accepted package substitution in %s", test.field)
		}
	}
	for _, kind := range []string{pythonWheel, pythonSdist} {
		for _, test := range []struct {
			value any
			field string
		}{
			{"../escape", pythonManifestFile},
			{"/artifact", pythonManifestFile},
			{strings.Repeat("A", pythonArtifactHashSize), pythonManifestHash},
			{json.Number(strings.Repeat("1", pythonArtifactHashSize)), pythonManifestHash},
			{nil, pythonManifestFile},
			{nil, pythonManifestHash},
			{true, pythonManifestExtraField},
		} {
			mutated := pythonManifestObject(t, data)
			artifact, isObject := pythonManifestEntry(t, mutated)[kind].(map[string]any)
			if !isObject {
				t.Fatal("fixture artifact missing")
			}
			artifact[test.field] = test.value
			if checkPythonReleaseManifest(pythonManifestJSON(t, mutated), selection) {
				t.Errorf("accepted %s artifact substitution", kind)
			}
		}
	}
}

func TestPythonManifestPackageOrderAndVersionSelection(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	document := pythonFixtureManifest(t, directory, selection)
	data := pythonManifestJSON(t, document)
	packages, isArray := document[pythonManifestPackages].([]any)
	if !isArray {
		t.Fatal("fixture package inventory failed")
	}
	for _, replacement := range [][]any{
		packages[:3], append(append([]any(nil), packages...), packages[0]),
		{packages[1], packages[0], packages[2], packages[3]},
		{packages[0], packages[0], packages[2], packages[3]},
	} {
		mutated := pythonManifestObject(t, data)
		mutated[pythonManifestPackages] = replacement
		if checkPythonReleaseManifest(pythonManifestJSON(t, mutated), selection) {
			t.Error("accepted missing, extra, reordered, or duplicate packages")
		}
	}
	selection.versions[pythonFixturePackage] = "0.1.2"
	if checkPythonReleaseManifest(data, selection) {
		t.Fatal("accepted a different selected package version")
	}
}

func FuzzPythonManifestIdentity(f *testing.F) {
	directory, selection := pythonManifestFixture(f)
	document := pythonFixtureManifest(f, directory, selection)
	f.Add(pythonManifestJSON(f, document))
	f.Add([]byte(`{"schemaVersion":true,"packages":[],"sourceCommit":null}`))
	f.Add([]byte("null"))
	f.Fuzz(func(t *testing.T, data []byte) {
		if checkPythonReleaseManifest(data, selection) {
			parsed, readable := readPythonManifestDocument(data)
			if !readable || !checkPythonReleaseManifest(pythonManifestJSON(t, parsed), selection) {
				t.Fatal("validated manifest did not preserve its identity through serialization")
			}
		}
	})
}
