package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryHTTPResponses(t *testing.T) {
	t.Parallel()
	plan, valid := newRegistryRequest("npm", jsMetadataCore, "")
	if !valid {
		t.Fatal("request plan unavailable")
	}
	for _, test := range []struct {
		body     string
		status   int
		readable bool
	}{
		{`{"dist-tags":{"latest":"1.2.3"}}`, http.StatusOK, true},
		{"malformed-registry-json", http.StatusOK, false},
		{"\xff", http.StatusOK, false},
		{strings.Repeat("x", pythonManifestLimit+1), http.StatusOK, false},
		{"", http.StatusNotFound, false},
		{"", http.StatusServiceUnavailable, false},
	} {
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("User-Agent") == "" {
				t.Error("registry client omitted identification")
			}
			response := new(http.Response)
			response.StatusCode = test.status
			response.Body = io.NopCloser(strings.NewReader(test.body))
			response.Header = make(http.Header)
			return response, nil
		})
		result := fetchRegistryResponse(context.Background(), client, plan)
		if result.status != test.status || result.readable != test.readable {
			t.Fatal("registry response decoding boundary changed")
		}
	}
}

func TestRegistryHTTPBodyFailures(t *testing.T) {
	t.Parallel()
	plan, _ := newRegistryRequest("npm", jsMetadataCore, "")
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		for _, closeFailure := range []bool{false, true} {
			body := &pythonRegistryFixtureBody{
				reader: strings.NewReader(`{}`), readError: true, closeError: closeFailure, closed: false,
			}
			client := new(http.Client)
			client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
				response := new(http.Response)
				response.StatusCode, response.Body = status, body
				return response, nil
			})
			result := fetchRegistryResponse(context.Background(), client, plan)
			if !body.closed || result.readable || closeFailure && result.status == http.StatusNotFound {
				t.Fatal("failed registry response retained success or leaked body")
			}
		}
	}
}

func TestRegistryHTTPCancellation(t *testing.T) {
	t.Parallel()
	plan, _ := newRegistryRequest("npm", jsMetadataCore, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		return nil, request.Context().Err()
	})
	result := fetchRegistryResponse(ctx, client, plan)
	if result.readable || result.status != 0 {
		t.Fatal("cancelled registry request accepted")
	}
}
