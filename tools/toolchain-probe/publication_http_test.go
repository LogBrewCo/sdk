package main

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPublicationHTTPResponses(t *testing.T) {
	t.Parallel()
	_, identity := publicationRunFixture()
	const revisionWidth = 40
	identity.workflowSHA, identity.sourceSHA = strings.Repeat("a", revisionWidth), strings.Repeat("b", revisionWidth)
	for _, body := range []string{`{"id":42}`, `{"id":42,"id":43}`, "[]", "invalid-json", "\xff"} {
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
			if request.URL.Host != "api.github.com" || request.Method != http.MethodGet ||
				request.Header.Get("Authorization") != "Bearer fixture-auth" {
				t.Error("publication request lost endpoint or authentication binding")
			}
			response := new(http.Response)
			response.StatusCode = http.StatusOK
			response.Body = io.NopCloser(strings.NewReader(body))
			return response, nil
		})
		document, valid := publicationRunRead(context.Background(), client, identity,
			"fixture-auth", "jobs")
		if valid != (body == `{"id":42}`) {
			t.Fatal("publication response decoding policy changed")
		}
		if valid && !publicationRunNumber(eventObject(document)["id"], identity.runID) {
			t.Fatal("publication reader changed decoded document")
		}
	}
}
