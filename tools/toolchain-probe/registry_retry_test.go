package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestRegistryRetryAttempts(t *testing.T) {
	t.Parallel()
	plan, _ := newRegistryRequest("npm", jsMetadataCore, "")
	for _, absent := range []bool{false, true} {
		attempts := 0
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
			attempts++
			response := new(http.Response)
			response.StatusCode = http.StatusOK
			body := `{"versions":{"old":{}}}`
			if attempts > 1 {
				body = `{"versions":{"wanted":{}}}`
			}
			response.Body = io.NopCloser(strings.NewReader(body))
			return response, nil
		})
		policy := registryRetryPolicy{retries: 2, delay: 0, absent: absent}
		if !verifyRegistryRequest(context.Background(), client, plan, map[string]bool{"wanted": true}, policy) {
			t.Fatal("registry retry or absence preflight rejected")
		}
		want := 2
		if absent {
			want = 1
		}
		if attempts != want {
			t.Fatal("registry attempt budget changed")
		}
		if !absent {
			attempts = 0
			assertRegistryRetryExhaustion(t, client, plan, policy, &attempts)
		}
	}
}

func assertRegistryRetryExhaustion(t *testing.T, client *http.Client, plan registryRequest,
	policy registryRetryPolicy, attempts *int,
) {
	t.Helper()
	expected := map[string]bool{"unavailable-version": true}
	if verifyRegistryRequest(context.Background(), client, plan, expected, policy) ||
		*attempts != policy.retries+1 {
		t.Fatal("registry retry exhaustion accepted or exceeded budget")
	}
}

func TestRegistryRetryCancellation(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if waitRegistryRetry(ctx, time.Hour) {
		t.Fatal("cancelled retry delay accepted")
	}
}
