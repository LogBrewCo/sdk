//go:build darwin || linux

package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	nugetPublicExisting      = "already-exists"
	nugetPublicRangeKey      = "range"
	nugetPublicHashAlgorithm = "SHA512"
	nugetPublicSourceIndex   = 7
	nugetPublicRequests      = 6
)

func nugetPublicArgumentsFixture(t *testing.T) []string {
	t.Helper()
	files := make(map[string]string)
	for _, id := range []string{dotnetMetadataCore, dotnetMetadataHTTP} {
		path := dotnetMetadataSource + id + "/" + id + dotnetMetadataProject
		files[path] = repositorySource(t, path)
	}
	return []string{
		nugetVersionFlag, "LogBrew=0.1.7", nugetVersionFlag, "LogBrew.HttpClient=0.1.2",
		nugetCommitFlag, nugetArtifactCommit, nugetSourceFlag, confidentialityFixture(t, files),
		nugetOutputFlag, filepath.Join(t.TempDir(), "public"),
	}
}

func TestNugetPublicCommandReadFailureIsBounded(t *testing.T) {
	t.Parallel()
	arguments := nugetPublicArgumentsFixture(t)
	arguments[nugetPublicSourceIndex] = t.TempDir()
	var output, diagnostic bytes.Buffer
	code := runNugetPublic(arguments, &output, &diagnostic)
	if code != exitFailure || output.Len() != 0 ||
		diagnostic.String() != "NuGet public artifact verification or publication failed\n" {
		t.Fatal("NuGet source-read failure changed its public diagnostic or exit code")
	}
}

func TestNugetPublicCancellationBeforeIO(t *testing.T) {
	t.Parallel()
	options := parseNugetPublicArguments(nugetPublicArgumentsFixture(t))
	var requests []string
	client := nugetPublicFixtureClient(t, nugetOutputFixture(t), &requests)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if executeNugetPublic(ctx, client, options) || len(requests) != 0 {
		t.Fatal("cancelled reconciliation made requests")
	}
	if executeNugetPublic(t.Context(), client, nil) || executeNugetPublic(t.Context(), nil, options) {
		t.Fatal("missing NuGet command state accepted")
	}
}

func TestNugetPublicCreatesOutputParents(t *testing.T) {
	t.Parallel()
	options := parseNugetPublicArguments(nugetPublicArgumentsFixture(t))
	options.destination = filepath.Join(options.destination, "nested", "bundle")
	var requests []string
	client := nugetPublicFixtureClient(t, nugetOutputFixture(t), &requests)
	if !executeNugetPublic(t.Context(), client, options) || len(requests) != nugetPublicRequests {
		t.Fatal("NuGet output parents were not created for a verified bundle")
	}
	readNugetOutputRecords(t, options.destination)
}

func TestNugetPublicArguments(t *testing.T) {
	t.Parallel()
	arguments := nugetPublicArgumentsFixture(t)
	for _, extra := range [][]string{nil, {nugetRangeFlag, nugetDependencyCoreRange}} {
		options := parseNugetPublicArguments(append(slices.Clone(arguments), extra...))
		if options == nil || options.sourceCommit != nugetArtifactCommit ||
			options.dependencyRange != nugetDependencyCoreRange || len(options.versions) != 2 {
			t.Fatal("selected NuGet arguments changed")
		}
	}
	for _, mutation := range []struct {
		value string
		index int
	}{
		{"--unsupported-nuget-option", 0},
		{"LogBrew=../0.1.7", 1},
		{"LogBrew=0.1.7", 3},
		{"LogBrew.HttpClient=0.1.2", 1},
		{"LogBrew.HttpClient=latest", 3},
		{nugetArtifactBranch, 5},
		{"relative-source", nugetPublicSourceIndex},
		{"relative-output", 9},
		{"/", 9},
		{"LogBrew=", 1},
		{"LogBrew.HttpClient=0.1.2=extra", 3},
		{"", nugetPublicSourceIndex},
	} {
		changed := slices.Clone(arguments)
		changed[mutation.index] = mutation.value
		if parseNugetPublicArguments(changed) != nil {
			t.Fatal("unsafe or ambiguous NuGet arguments accepted")
		}
	}
	for _, extra := range [][]string{
		{nugetCommitFlag, nugetArtifactCommit},
		{nugetVersionFlag, "LogBrew.AspNetCore=0.1.5"},
		{nugetRangeFlag, "[0.1.6, 0.2.0)"},
		{nugetRangeFlag, ""},
		{pythonSmokeManifestFlag, "separate.json"},
	} {
		if parseNugetPublicArguments(append(slices.Clone(arguments), extra...)) != nil {
			t.Fatal("extra, duplicate or mismatched NuGet argument accepted")
		}
	}
	var output, diagnostic bytes.Buffer
	if runNugetPublic(nil, &output, &diagnostic) != exitUsage || output.Len() != 0 || diagnostic.Len() == 0 {
		t.Fatal("NuGet argument failure lost its exit code or diagnostics")
	}
}

func nugetPublicFixtureClient(t *testing.T, packages []nugetResolvedPackage, requests *[]string) *http.Client {
	t.Helper()
	responses := make(map[string][]byte)
	for _, item := range packages {
		addresses := item.spec.registryURLs()
		catalog := nugetCatalogRoot + nugetCatalogFixtureTime + "/" +
			strings.ToLower(item.spec.id) + "." + item.spec.version + ".json"
		groups := make([]any, 0, len(item.spec.dependencies.frameworks))
		for _, framework := range item.spec.dependencies.frameworks {
			dependencies := make([]any, 0, len(item.spec.dependencies.dependencies))
			for id, versionRange := range item.spec.dependencies.dependencies {
				dependencies = append(dependencies, map[string]any{"id": id, nugetPublicRangeKey: versionRange})
			}
			groups = append(groups, map[string]any{
				nugetRegistryFramework: framework, nugetRegistryDependencies: dependencies,
			})
		}
		responses[addresses.metadata] = pythonManifestJSON(t, map[string]any{
			"packageContent": addresses.packageURL, "catalogEntry": catalog,
		})
		responses[catalog] = pythonManifestJSON(t, map[string]any{
			"id": item.spec.id, pythonManifestVersion: item.spec.version,
			"packageHashAlgorithm": nugetPublicHashAlgorithm,
			"packageHash":          item.artifact.registrySHA512, "dependencyGroups": groups,
		})
		responses[addresses.packageURL] = item.artifact.data
	}
	client := newNugetRegistryClient()
	if client == nil {
		t.Fatal("NuGet fixture client unavailable")
	}
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		*requests = append(*requests, request.URL.String())
		body, found := responses[request.URL.String()]
		if !found {
			t.Fatal("NuGet request escaped the exact selected pair")
		}
		response := new(http.Response)
		response.Request, response.StatusCode, response.ContentLength = request, http.StatusOK, int64(len(body))
		response.Body = io.NopCloser(bytes.NewReader(body))
		return response, nil
	})
	return client
}

func TestNugetPublicReconciliation(t *testing.T) {
	t.Parallel()
	for _, sample := range []struct {
		failure           string
		requests, entries int
	}{
		{"none", nugetPublicRequests, 1},
		{"second-package", nugetPublicRequests, 0},
		{"source-unavailable", 0, 0},
		{nugetPublicExisting, 0, 1},
	} {
		t.Run(sample.failure, func(t *testing.T) {
			t.Parallel()
			failure := sample.failure
			options := parseNugetPublicArguments(nugetPublicArgumentsFixture(t))
			packages := nugetOutputFixture(t)
			prepareNugetPublicFailure(t, options, packages, failure)
			var requests []string
			client := nugetPublicFixtureClient(t, packages, &requests)
			accepted := executeNugetPublic(t.Context(), client, options)
			if accepted != (failure == "none") {
				t.Fatal("NuGet reconciliation returned the wrong outcome")
			}
			if len(requests) != sample.requests {
				t.Fatal("NuGet reconciliation fetched before preflight or retried")
			}
			entries, err := os.ReadDir(filepath.Dir(options.destination))
			if err != nil || len(entries) != sample.entries {
				t.Fatal("NuGet reconciliation left partial output")
			}
		})
	}
}

func prepareNugetPublicFailure(
	t *testing.T, options *nugetPublicOptions, packages []nugetResolvedPackage, failure string,
) {
	t.Helper()
	if failure == "second-package" {
		packages[1].artifact.data = append(packages[1].artifact.data, 'x')
	}
	if failure == "source-unavailable" {
		options.sourceRoot = t.TempDir()
	}
	if failure == nugetPublicExisting {
		if err := os.Mkdir(options.destination, pythonBundleDirectoryMode); err != nil {
			t.Fatal(err)
		}
	}
}
