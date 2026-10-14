//go:build darwin || linux

package main

import (
	"bytes"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func pythonPublicOutputFixture(t *testing.T) pythonPublicBundle {
	t.Helper()
	directory, selection := pythonManifestFixture(t)
	manifest := pythonManifestJSON(t, pythonFixtureManifest(t, directory, selection))
	responses := pythonPublicBundleFixture(t, directory, selection)
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		response := new(http.Response)
		response.Request, response.StatusCode = request, http.StatusOK
		response.Body = io.NopCloser(bytes.NewReader(responses[request.URL.String()]))
		return response, nil
	})
	bundle, valid := preparePythonPublicBundle(t.Context(), client, directory, manifest)
	if !valid {
		t.Fatal("public output fixture failed")
	}
	return bundle
}

func TestPythonPublicOutputPublishesCompleteBundle(t *testing.T) {
	t.Parallel()
	bundle := pythonPublicOutputFixture(t)
	parent := t.TempDir()
	directory := filepath.Join(parent, "public")
	if !writePythonPublicBundle(directory, bundle) {
		t.Fatal("complete bundle was not published")
	}
	for name, expected := range map[string][]byte{
		pythonPublicManifestName: pythonManifestJSON(t, bundle.manifest),
		pythonPublicReceiptName:  pythonManifestJSON(t, bundle.reconciliation),
	} {
		actual, readable := readCheckFile(filepath.Join(directory, name))
		if !readable || !bytes.Equal(bytes.TrimSpace(actual), bytes.TrimSpace(expected)) {
			t.Fatal("published receipt is missing or differs")
		}
	}
	if !verifyPythonReleaseManifest(directory, pythonManifestJSON(t, bundle.manifest)) {
		t.Fatal("published artifacts do not match the receipt")
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 1 || entries[0].Name() != "public" ||
		writePythonPublicBundle(directory, bundle) {
		t.Fatal("publication left staging output or overwrote an existing bundle")
	}
}

func TestPythonPublicOutputRejectsIncompleteOrChangedEvidence(t *testing.T) {
	t.Parallel()
	for _, mutation := range []string{
		pythonPublicMissingArtifact, "corrupted-artifact", pythonManifestExtraField,
		"receipt", "manifest", "digest", "incomplete-result",
	} {
		t.Run(mutation, func(t *testing.T) {
			t.Parallel()
			bundle := pythonPublicOutputFixture(t)
			mutatePythonPublicOutput(t, &bundle, mutation)
			parent := t.TempDir()
			if writePythonPublicBundle(filepath.Join(parent, "public"), bundle) {
				t.Fatal("invalid bundle was published")
			}
			entries, err := os.ReadDir(parent)
			if err != nil || len(entries) != 0 {
				t.Fatal("failed bundle left partial or staged output")
			}
		})
	}
}

func mutatePythonPublicOutput(t *testing.T, bundle *pythonPublicBundle, mutation string) {
	t.Helper()
	name := "logbrew_flask/logbrew_flask-0.1.1-py3-none-any.whl"
	switch mutation {
	case pythonPublicMissingArtifact:
		delete(bundle.artifacts, name)
	case "corrupted-artifact":
		bundle.artifacts[name] = []byte("corrupted")
	case pythonManifestExtraField:
		bundle.artifacts["../outside"] = []byte("outside")
	case "receipt":
		bundle.reconciliation[pythonManifestCommitKey] = "mismatch"
	case "manifest":
		bundle.manifest[pythonManifestCommitKey] = "mismatch"
	case "digest":
		corruptPythonPublicManifestDigest(t, bundle.manifest)
	case "incomplete-result":
		bundle.failure = "incomplete"
	default:
		t.Fatal("unknown public bundle mutation")
	}
}

func corruptPythonPublicManifestDigest(t *testing.T, manifest map[string]any) {
	t.Helper()
	packages, valid := manifest[pythonManifestPackages].([]any)
	if !valid {
		t.Fatal("invalid fixture packages")
	}
	entry, valid := packages[0].(map[string]any)
	if !valid {
		t.Fatal("invalid fixture package")
	}
	artifact, valid := entry[pythonWheel].(map[string]any)
	if !valid {
		t.Fatal("invalid fixture artifact")
	}
	artifact[pythonManifestHash] = pythonManifestFixtureCommit + "aaaaaaaaaaaaaaaaaaaaaaaa"
}

func TestPythonPublicOutputRejectsUnsafeDestinations(t *testing.T) {
	t.Parallel()
	bundle := pythonPublicOutputFixture(t)
	parent := t.TempDir()
	for _, destination := range []string{
		"nonabsolute-output", "/", parent + "/../public", parent + "/public/", parent,
	} {
		if writePythonPublicBundle(destination, bundle) {
			t.Fatal("invalid or existing destination accepted")
		}
	}
	entries, err := os.ReadDir(parent)
	if err != nil || len(entries) != 0 {
		t.Fatal("invalid destination changed the parent")
	}
}
