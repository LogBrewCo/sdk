package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"testing"
)

func pythonPublicBundleFixture(t *testing.T, directory string, selection pythonReleaseSelection) map[string][]byte {
	t.Helper()
	responses := make(map[string][]byte)
	for _, spec := range pythonReleaseCatalog() {
		version := selection.versions[spec.id]
		files := make([]any, 0, pythonReleaseFileCount)
		for _, kind := range []string{pythonWheel, pythonSdist} {
			relative := pythonReleaseArtifactPath(spec, version, kind)
			built, readable := readCheckFile(filepath.Join(directory, relative))
			if !readable {
				t.Fatal("bundle fixture file unavailable")
			}
			public := repackPythonPublicFixture(built, kind)
			address := "https://files.pythonhosted.org/packages/example/" + path.Base(relative)
			responses[address] = public
			packageType := pythonSdist
			if kind == pythonWheel {
				packageType = pythonPublicType
			}
			files = append(files, map[string]any{
				pythonPublicFilename: path.Base(relative), "packagetype": packageType, pythonPublicURL: address,
				"digests": map[string]any{pythonManifestHash: fmt.Sprintf("%x", sha256.Sum256(public))},
			})
		}
		responses["https://pypi.org/pypi/"+spec.id+"/"+version+"/json"] = pythonManifestJSON(t, map[string]any{
			"info": map[string]any{pythonPublicName: spec.id, pythonManifestVersion: version}, pythonPublicURLs: files,
		})
	}
	return responses
}

func TestPythonPublicBundleBindsAllFourPackages(t *testing.T) {
	t.Parallel()
	directory, selection := pythonManifestFixture(t)
	manifest := pythonManifestJSON(t, pythonFixtureManifest(t, directory, selection))
	responses := pythonPublicBundleFixture(t, directory, selection)
	client := newPythonRegistryClient()
	if client == nil {
		t.Fatal("registry client unavailable")
	}
	defer client.CloseIdleConnections()
	requests := 0
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		data, exists := responses[request.URL.String()]
		if !exists || request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatal("bundle requested unexpected or authenticated content")
		}
		response := new(http.Response)
		response.Request, response.StatusCode = request, http.StatusOK
		response.Body = io.NopCloser(bytes.NewReader(data))
		return response, nil
	})
	bundle, valid := preparePythonPublicBundle(t.Context(), client, directory, manifest)
	if !valid || len(bundle.artifacts) != len(pythonReleaseCatalog())*pythonReleaseFileCount ||
		requests != len(pythonReleaseCatalog())*(pythonReleaseFileCount+1) {
		t.Fatal("bundle omitted package verification or repeated a registry request")
	}
	output := t.TempDir()
	for relative, data := range bundle.artifacts {
		filename := filepath.Join(output, relative)
		if err := os.MkdirAll(filepath.Dir(filename), pythonManifestDirectoryMode); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, data, fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	if !verifyPythonReleaseManifest(output, pythonManifestJSON(t, bundle.manifest)) ||
		!checkPythonReleaseManifest(pythonManifestJSON(t, bundle.manifest), selection) {
		t.Fatal("downloaded bundle did not independently verify its complete manifest")
	}
}

func TestPythonPublicBundleDiscardsPartialEvidence(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{
		"manifest-before-network", "registry-body", "build-after-preflight", "compressed-bomb",
	} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			directory, selection := pythonManifestFixture(t)
			manifest := pythonManifestJSON(t, pythonFixtureManifest(t, directory, selection))
			responses := pythonPublicBundleFixture(t, directory, selection)
			expectedRequests := 1
			switch failure {
			case "manifest-before-network":
				manifest, expectedRequests = []byte("null"), 0
			case "compressed-bomb":
				poisonPythonPublicWheel(t, selection, responses)
				expectedRequests = 2
			default:
			}
			requests := 0
			client := new(http.Client)
			client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
				requests++
				body := pythonPublicFailureBody(t, failure, directory, selection, responses[request.URL.String()])
				response := new(http.Response)
				response.Request, response.StatusCode = request, http.StatusOK
				response.Body = io.NopCloser(bytes.NewReader(body))
				return response, nil
			})
			bundle, valid := preparePythonPublicBundle(t.Context(), client, directory, manifest)
			if valid || len(bundle.artifacts) != 0 || bundle.manifest != nil || bundle.reconciliation != nil ||
				requests != expectedRequests {
				t.Fatal("failed reconciliation returned partial evidence or continued fetching")
			}
			if files, writable := pythonPublicOutputFiles(bundle); writable || len(files) != 0 {
				t.Fatal("failed reconciliation produced writable output")
			}
		})
	}
}

func poisonPythonPublicWheel(t *testing.T, selection pythonReleaseSelection, responses map[string][]byte) {
	t.Helper()
	spec := pythonReleaseCatalog()[0]
	version := selection.versions[spec.id]
	metadataURL := "https://pypi.org/pypi/" + spec.id + "/" + version + "/json"
	metadata := pythonManifestObject(t, responses[metadataURL])
	files, valid := metadata[pythonPublicURLs].([]any)
	if !valid || len(files) != pythonReleaseFileCount {
		t.Fatal("fixture metadata unavailable")
	}
	entry, valid := files[0].(map[string]any)
	if !valid {
		t.Fatal("fixture wheel metadata unavailable")
	}
	address := "https://files.pythonhosted.org/packages/example/" +
		path.Base(pythonReleaseArtifactPath(spec, version, pythonWheel))
	data := bytes.Clone(responses[address])
	offset := bytes.Index(data, []byte(pythonZipDirectorySignature))
	if offset < 0 {
		t.Fatal("fixture wheel directory unavailable")
	}
	// The registry authenticates these exact bytes. Archive expansion must still
	// fail before any partial bundle can become publishable evidence.
	binary.LittleEndian.PutUint32(data[offset+pythonZipSizeOffset:], pythonArchiveMemberBytes+1)
	entry["digests"] = map[string]any{pythonManifestHash: fmt.Sprintf("%x", sha256.Sum256(data))}
	responses[address], responses[metadataURL] = data, pythonManifestJSON(t, metadata)
}

func pythonPublicFailureBody(
	t *testing.T, failure, directory string, selection pythonReleaseSelection, data []byte,
) []byte {
	t.Helper()
	if failure == "build-after-preflight" {
		name := filepath.Join(directory, pythonReleaseArtifactPath(pythonReleaseCatalog()[0],
			selection.versions[pythonReleaseCatalog()[0].id], pythonWheel))
		if err := os.WriteFile(name, []byte("changed"), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	if failure == "registry-body" {
		return []byte("null")
	}
	return data
}
