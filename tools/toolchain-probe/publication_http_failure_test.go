package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func publicationHTTPIdentity() publicationRunIdentity {
	_, identity := publicationRunFixture()
	const revisionWidth = 40
	identity.workflowSHA, identity.sourceSHA = strings.Repeat("a", revisionWidth), strings.Repeat("b", revisionWidth)
	return identity
}

func TestPublicationHTTPBodyFailures(t *testing.T) {
	t.Parallel()
	for _, status := range []int{http.StatusOK, http.StatusForbidden} {
		for _, closeFailure := range []bool{false, true} {
			body := &pythonRegistryFixtureBody{
				reader: strings.NewReader(`{}`), readError: !closeFailure, closeError: closeFailure, closed: false,
			}
			client := new(http.Client)
			client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
				response := new(http.Response)
				response.StatusCode, response.Body = status, body
				return response, nil
			})
			_, valid := publicationRunRead(context.Background(), client, publicationHTTPIdentity(),
				"fixture-read-authorization", publicationReadRun)
			if valid || !body.closed {
				t.Fatal("failed publication body accepted or not closed")
			}
		}
	}
}

func TestPublicationHTTPPreflight(t *testing.T) {
	t.Parallel()
	client := new(http.Client)
	requests := 0
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		requests++
		return nil, context.Canceled
	})
	identity := publicationHTTPIdentity()
	for _, authorization := range []string{"", "invalid header", "invalid\nheader"} {
		_, valid := publicationRunRead(context.Background(), client, identity, authorization, publicationReadRun)
		if valid {
			t.Fatal("invalid publication authorization accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, valid := publicationRunRead(ctx, client, identity, "fixture-read-authorization", publicationReadRun); valid {
		t.Fatal("cancelled publication read accepted")
	}
	if requests != 0 {
		t.Fatal("rejected publication request reached transport")
	}
}
