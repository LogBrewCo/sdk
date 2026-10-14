package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryRunChecks(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.targets = []string{registryNPMFamily, registryPythonFamily}
	selection.npmPackages = []string{jsMetadataCore}
	policy := new(registryVersionPolicy)
	policy.version = "1.2.8"
	checks, valid := registryPlanChecks(selection, policy)
	if !valid {
		t.Fatal("planning failed")
	}
	calls := 0
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		body := `{"versions":{"1.2.8":{}}}`
		if request.URL.Host == "pypi.org" {
			body = `{"releases":{"previous":{}}}`
		}
		response := new(http.Response)
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(body))
		return response, nil
	})
	retry := registryRetryPolicy{retries: 1, delay: 0, absent: false}
	results, complete := runRegistryChecks(context.Background(), client, checks, retry)
	expectedOutcome := registryOutcome{reason: "version-not-found", status: http.StatusOK, attempts: 2, passed: false}
	if !complete || len(results) != 2 || calls != 3 || !results[0].passed || results[1].passed ||
		registryResultsPassed(results) || results[1].family != registryPythonFamily ||
		results[1].outcome != expectedOutcome {
		t.Fatalf("results = %v calls %d", results, calls)
	}
	policy.version = "previous"
	checks, valid = registryPlanChecks(selection, policy)
	if !valid {
		t.Fatal("second planning failed")
	}
	results, complete = runRegistryChecks(context.Background(), client, checks, retry)
	if !complete || results[0].passed || !results[1].passed {
		t.Fatal("did not continue after failed package")
	}
}

func TestRegistryRunCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		calls++
		cancel()
		response := new(http.Response)
		response.StatusCode = http.StatusNotFound
		response.Body = io.NopCloser(strings.NewReader(""))
		return response, nil
	})
	request, _ := newRegistryRequest(registryNPMFamily, jsMetadataCore, "")
	check := registryPlannedCheck{request: request, expected: map[string]bool{"1": true}}
	retry := registryRetryPolicy{retries: 0, delay: 0, absent: false}
	results, complete := runRegistryChecks(ctx, client, []registryPlannedCheck{check, check}, retry)
	if complete || len(results) != 1 || calls != 1 {
		t.Fatal("cancellation did not stop later requests")
	}
	if _, complete = runRegistryChecks(context.Background(), nil, nil, retry); complete {
		t.Fatal("nil client accepted")
	}
	retry.retries = -1
	if _, complete = runRegistryChecks(context.Background(), client, nil, retry); complete {
		t.Fatal("invalid retry accepted")
	}
}
