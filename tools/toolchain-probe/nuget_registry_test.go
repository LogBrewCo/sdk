package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
)

const (
	nugetRegistryLogging      = "Microsoft.Extensions.Logging"
	nugetRegistryDependencies = "dependencies"
	nugetRegistryFramework    = "targetFramework"
	nugetCatalogFixtureTime   = "2026.07.24.11.22.33"
	nugetCatalogFixtureURL    = "https://api.nuget.org/v3/catalog0/data/" +
		nugetCatalogFixtureTime + "/logbrew.0.1.7.json"
	nugetPackageFixtureURL = "https://api.nuget.org/v3-flatcontainer/logbrew/0.1.7/logbrew.0.1.7.nupkg"
)

type nugetRegistryFixture struct {
	client      *http.Client
	responses   map[string][]byte
	encodings   map[string][]string
	requests    []string
	packageData []byte
}

func newNugetRegistryFixture(t *testing.T) *nugetRegistryFixture {
	t.Helper()
	data := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(nugetArtifactNuspec, nugetArtifactDocument)})
	digest := sha512.Sum512(data)
	groups := make([]any, 0, 2)
	for _, framework := range []string{nugetDependencyAlias, nugetDependencyNet8} {
		groups = append(groups, map[string]any{nugetRegistryFramework: framework, nugetRegistryDependencies: []any{
			map[string]any{"id": nugetRegistryLogging, "range": nugetDependencyMinimum},
		}})
	}
	fixture := &nugetRegistryFixture{
		client: newNugetRegistryClient(), requests: nil, packageData: data, encodings: make(map[string][]string),
		responses: map[string][]byte{
			nugetHTTPFixtureURL: pythonManifestJSON(t, map[string]any{
				"packageContent": nugetPackageFixtureURL, "catalogEntry": nugetCatalogFixtureURL,
			}),
			nugetCatalogFixtureURL: pythonManifestJSON(t, map[string]any{
				"id": dotnetMetadataCore, pythonManifestVersion: nugetArtifactVersion, "packageHashAlgorithm": "SHA512",
				"packageHash": base64.StdEncoding.EncodeToString(digest[:]), "dependencyGroups": groups,
			}),
			nugetPackageFixtureURL: data,
		},
	}
	if fixture.client == nil {
		t.Fatal("NuGet client unavailable")
	}
	fixture.client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		address := request.URL.String()
		encoding := nugetEncodingGzip
		if address == nugetPackageFixtureURL {
			encoding = ""
		}
		if request.Header.Get("Accept-Encoding") != encoding || request.Header.Get("Authorization") != "" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("User-Agent") == "" {
			t.Fatal("registry request changed encoding or public access policy")
		}
		body, found := fixture.responses[address]
		if !found {
			t.Fatal("registry request escaped the selected package")
		}
		fixture.requests = append(fixture.requests, address)
		response := new(http.Response)
		response.Header = http.Header{"Content-Encoding": fixture.encodings[address]}
		response.StatusCode, response.Request, response.ContentLength = http.StatusOK, request, int64(len(body))
		response.Body = io.NopCloser(bytes.NewReader(body))
		return response, nil
	})
	return fixture
}

func TestNugetRegistryArtifactChain(t *testing.T) {
	t.Parallel()
	fixture := newNugetRegistryFixture(t)
	artifact := fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture())
	digest := sha256.Sum256(fixture.packageData)
	digest512 := sha512.Sum512(fixture.packageData)
	if artifact == nil || !bytes.Equal(artifact.data, fixture.packageData) ||
		artifact.sha256 != hex.EncodeToString(digest[:]) || artifact.contentSHA256 == "" ||
		artifact.registrySHA512 != base64.StdEncoding.EncodeToString(digest512[:]) ||
		!slices.Equal(fixture.requests, []string{nugetHTTPFixtureURL, nugetCatalogFixtureURL, nugetPackageFixtureURL}) {
		t.Fatal("selected registry-to-source package chain did not verify")
	}
	fixture.responses[nugetPackageFixtureURL] = append(bytes.Clone(fixture.packageData), 'x')
	if fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture()) != nil {
		t.Fatal("changed downloaded bytes retained registry acceptance")
	}
}

func TestNugetCatalogURLContract(t *testing.T) {
	t.Parallel()
	spec := nugetArtifactFixture()
	for _, timestamp := range []string{nugetCatalogFixtureTime, "2024.02.29.23.59.59"} {
		address := strings.ReplaceAll(nugetCatalogFixtureURL, nugetCatalogFixtureTime, timestamp)
		if !spec.validCatalogURL(address) {
			t.Fatal("canonical catalog URL rejected")
		}
	}
	for _, change := range [][2]string{
		{nugetCatalogFixtureTime, "2026.7.24.11.22.33"},
		{nugetCatalogFixtureTime, "2026.02.30.11.22.33"},
		{nugetCatalogFixtureTime, "2025.02.29.11.22.33"},
		{nugetCatalogFixtureTime, "0000.01.01.00.00.00"},
		{nugetCatalogFixtureTime, "2026.07.24.24.22.33"},
		{nugetCatalogFixtureTime, "2026.07.24.11.60.33"},
		{nugetCatalogFixtureTime, "2026.07.24.11.22.60"},
		{nugetCatalogFixtureTime, "2026.07.24.11.22"},
		{"logbrew.0.1.7.json", "LogBrew.0.1.7.json"},
		{"0.1.7.json", "0.1.6.json"},
		{"api.nuget.org", "api.nuget.org:443"},
		{"api.nuget.org", "user@api.nuget.org"},
		{"/logbrew", "/../logbrew"},
		{"/logbrew", "/%2Flogbrew"},
		{"logbrew.0", "logbrew%2e0"},
		{".json", ".json?download=true"},
		{".json", ".json#catalog"},
	} {
		if spec.validCatalogURL(strings.ReplaceAll(nugetCatalogFixtureURL, change[0], change[1])) {
			t.Fatal("noncanonical or unselected catalog URL accepted")
		}
	}
}

func TestNugetRegistryGzipMetadata(t *testing.T) {
	t.Parallel()
	fixture := newNugetRegistryFixture(t)
	for _, address := range []string{nugetHTTPFixtureURL, nugetCatalogFixtureURL} {
		fixture.responses[address] = pythonFixtureGzip(t, fixture.responses[address])
		fixture.encodings[address] = []string{nugetEncodingGzip}
	}
	if fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture()) == nil {
		t.Fatal("gzip registration and catalog chain rejected")
	}
}

func TestNugetRegistryRejectsBrokenChain(t *testing.T) {
	t.Parallel()
	for _, mutation := range []struct {
		address, old, replacement string
		requests                  int
	}{
		{nugetHTTPFixtureURL, nugetPackageFixtureURL, "https://example.invalid/package", 1},
		{nugetHTTPFixtureURL, nugetCatalogFixtureURL, "https://example.invalid/catalog", 1},
		{nugetHTTPFixtureURL, `"catalogEntry"`, `"absentEntry"`, 1},
		{nugetCatalogFixtureURL, `"id":"LogBrew"`, `"id":"Other"`, 2},
		{nugetCatalogFixtureURL, nugetArtifactVersion, "0.1.8", 2},
		{nugetCatalogFixtureURL, "SHA512", "SHA256", 2},
		{nugetCatalogFixtureURL, `"packageHash"`, `"absentHash"`, 2},
		{nugetCatalogFixtureURL, nugetRegistryLogging, "Other.Dependency", 2},
		{nugetCatalogFixtureURL, nugetDependencyMinimum, "[10.0.8, )", 2},
		{nugetCatalogFixtureURL, "net8.0", "NET8.0", 2},
		{nugetCatalogFixtureURL, `"dependencyGroups"`, `"absentGroups"`, 2},
	} {
		fixture := newNugetRegistryFixture(t)
		data := fixture.responses[mutation.address]
		changed := bytes.ReplaceAll(data, []byte(mutation.old), []byte(mutation.replacement))
		if bytes.Equal(data, changed) {
			t.Fatal("registry mutation did not change its target")
		}
		fixture.responses[mutation.address] = changed
		if fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture()) != nil ||
			len(fixture.requests) != mutation.requests {
			t.Fatal("broken registry chain accepted or contacted a later stage")
		}
	}
	for _, address := range []string{nugetHTTPFixtureURL, nugetCatalogFixtureURL} {
		fixture := newNugetRegistryFixture(t)
		fixture.responses[address] = []byte(`{"id":"LogBrew","id":"LogBrew"}`)
		if fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture()) != nil {
			t.Fatal("ambiguous registry JSON accepted")
		}
	}
}

func TestNugetRegistryHashDoesNotReplaceSourceBinding(t *testing.T) {
	t.Parallel()
	fixture := newNugetRegistryFixture(t)
	original := sha512.Sum512(fixture.packageData)
	changed := pythonFixtureZip(t, []pythonArchiveEntry{pythonFixtureFile(nugetArtifactNuspec,
		strings.ReplaceAll(nugetArtifactDocument, nugetArtifactCommit, strings.Repeat("b", pythonSourceCommitSize)))})
	digest := sha512.Sum512(changed)
	fixture.responses[nugetPackageFixtureURL] = changed
	fixture.responses[nugetCatalogFixtureURL] = bytes.ReplaceAll(fixture.responses[nugetCatalogFixtureURL],
		[]byte(base64.StdEncoding.EncodeToString(original[:])), []byte(base64.StdEncoding.EncodeToString(digest[:])))
	if fetchNugetPublicArtifact(t.Context(), fixture.client, nugetArtifactFixture()) != nil ||
		len(fixture.requests) != 3 {
		t.Fatal("registry hash concealed a changed package source commit")
	}
}

func TestNugetRegistrySelectedURLs(t *testing.T) {
	t.Parallel()
	spec := nugetArtifactFixture()
	for _, entry := range []struct{ id, version, metadata, packageURL string }{
		{dotnetMetadataCore, nugetArtifactVersion, nugetHTTPFixtureURL, nugetPackageFixtureURL},
		{
			dotnetMetadataHTTP, nugetArtifactHTTPVersion,
			"https://api.nuget.org/v3/registration5-gz-semver2/logbrew.httpclient/0.1.2.json",
			"https://api.nuget.org/v3-flatcontainer/logbrew.httpclient/0.1.2/logbrew.httpclient.0.1.2.nupkg",
		},
	} {
		spec.id, spec.version = entry.id, entry.version
		addresses := spec.registryURLs()
		if addresses.metadata != entry.metadata || addresses.packageURL != entry.packageURL {
			t.Fatal("selected registry URL changed")
		}
	}
}
