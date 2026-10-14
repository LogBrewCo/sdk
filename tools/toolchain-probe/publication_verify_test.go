package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPublicationVerificationStopsAtUnboundRun(t *testing.T) {
	t.Parallel()
	client := new(http.Client)
	requests := 0
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		requests++
		response := new(http.Response)
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(`{"id":42}`))
		return response, nil
	})
	if verifyPublicationRun(context.Background(), client, publicationHTTPIdentity(), "verify-fixture-auth") ||
		requests != 1 {
		t.Fatal("unbound publication run reached jobs or passed")
	}
}
