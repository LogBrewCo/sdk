package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryCommandExecution(t *testing.T) {
	t.Parallel()
	options := prepareRegistryOptions(strings.Fields(`--target=npm --target=go --npm-package=@logbrew/sdk --retries=0`))
	if options == nil {
		t.Fatal("command preparation failed")
	}
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		response := new(http.Response)
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(`{"versions":{"0.1.0":{}}}`))
		return response, nil
	})
	goCalls := 0
	verifier := func(_ context.Context, version string) bool { goCalls++; return version == registryDefaultVersion }
	output := new(bytes.Buffer)
	if executeRegistryPublication(context.Background(), client, options, verifier, output) != exitOK || goCalls != 1 ||
		!strings.Contains(output.String(), `"expected_checks":2`) {
		t.Fatal("full command result lost HTTP or Go check")
	}
	if executeRegistryPublication(context.Background(), client, options, nil, io.Discard) != exitFailure {
		t.Fatal("missing Go verifier reported success")
	}
}

func TestRegistryCommandRejectsBeforeNetwork(t *testing.T) {
	t.Parallel()
	output, diagnostic := new(bytes.Buffer), new(bytes.Buffer)
	if runRegistryPublication([]string{"--target=invalid"}, output, diagnostic) != exitUsage || output.Len() != 0 {
		t.Fatal("invalid command did not fail before execution")
	}
}
