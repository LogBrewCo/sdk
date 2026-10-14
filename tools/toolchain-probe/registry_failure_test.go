package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryFailureCategories(t *testing.T) {
	t.Parallel()
	plan, _ := newRegistryRequest(registryNPMFamily, jsMetadataCore, "")
	cases := []struct {
		body, reason string
		status       int
	}{
		{`{"versions":{"old":{}}}`, "versions-read", http.StatusOK},
		{"malformed", "invalid-json", http.StatusOK},
		{"\xff", "response-unreadable", http.StatusOK},
		{"", registryHTTPStatusReason, http.StatusServiceUnavailable},
	}
	for _, test := range cases {
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
			response := new(http.Response)
			response.StatusCode = test.status
			response.Body = io.NopCloser(strings.NewReader(test.body))
			return response, nil
		})
		result := fetchRegistryResponse(context.Background(), client, plan)
		if result.reason != test.reason || result.status != test.status {
			t.Fatalf("category = %s status %d", result.reason, result.status)
		}
	}
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		return nil, io.ErrUnexpectedEOF
	})
	result := fetchRegistryResponse(context.Background(), client, plan)
	if result.reason != "transport-failed" || result.status != 0 {
		t.Fatal("transport category missing")
	}
	if result = fetchRegistryResponse(context.Background(), nil, plan); result.reason != "invalid-request" {
		t.Fatal("invalid request category missing")
	}
}
