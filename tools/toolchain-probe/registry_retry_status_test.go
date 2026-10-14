package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestRegistryRetryMissingPages(t *testing.T) {
	t.Parallel()
	const expectedAttempts = 4
	for _, status := range []int{http.StatusNotFound, 0} {
		attempts := 0
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
			attempts++
			if status == 0 {
				return nil, io.ErrUnexpectedEOF
			}
			response := new(http.Response)
			response.StatusCode = status
			body := ""
			if attempts == expectedAttempts {
				response.StatusCode = http.StatusOK
				body = `{"versions":{"wanted":{}}}`
			}
			response.Body = io.NopCloser(strings.NewReader(body))
			return response, nil
		})
		plan, _ := newRegistryRequest(registryNPMFamily, jsMetadataCore, "")
		outcome := registryRequestOutcome(context.Background(), client, plan, map[string]bool{"wanted": true},
			registryRetryPolicy{retries: expectedAttempts - 1, delay: 0, absent: false})
		if attempts != expectedAttempts || outcome.attempts != expectedAttempts || outcome.passed != (status != 0) {
			t.Fatal("HTTP or transport failure changed retry budget or result")
		}
	}
}
