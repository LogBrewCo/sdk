package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestPublicationHTTPRedirectRejected(t *testing.T) {
	t.Parallel()
	client := new(http.Client)
	requests, redirectCallbacks := 0, 0
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		redirectCallbacks++
		return nil
	}
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.URL.Host != "api.github.com" {
			t.Error("publication authorization followed redirect")
		}
		response := new(http.Response)
		response.StatusCode = http.StatusFound
		response.Header = make(http.Header)
		response.Header.Set("Location", "https://example.invalid/redirect-target")
		response.Body = io.NopCloser(strings.NewReader("redirect"))
		return response, nil
	})
	_, valid := publicationRunRead(context.Background(), client, publicationHTTPIdentity(),
		"redirect-fixture-auth", publicationReadRun)
	if valid || requests != 1 || redirectCallbacks != 0 || client.CheckRedirect == nil {
		t.Fatal("publication redirect policy changed or mutated caller")
	}
}

func TestPublicationHTTPBoundAndDeadline(t *testing.T) {
	t.Parallel()
	client := new(http.Client)
	client.Timeout = time.Hour
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		deadline, bounded := request.Context().Deadline()
		if !bounded || time.Until(deadline) > publicationReadTimeout ||
			request.URL.Path != "/repos/LogBrewCo/sdk/actions/runs/42/jobs" ||
			request.URL.RawQuery != "per_page=100" ||
			request.Header.Get("Accept") != "application/vnd.github+json" ||
			request.Header.Get("X-Github-Api-Version") != "2022-11-28" {
			t.Error("publication request lost deadline, endpoint or API contract")
		}
		response := new(http.Response)
		response.StatusCode = http.StatusOK
		response.Body = io.NopCloser(strings.NewReader(strings.Repeat("x", pythonManifestLimit+1)))
		return response, nil
	})
	_, valid := publicationRunRead(context.Background(), client, publicationHTTPIdentity(),
		"bounded-fixture-auth", "jobs")
	if valid || client.Timeout != time.Hour {
		t.Fatal("oversized publication accepted or caller timeout mutated")
	}
}
