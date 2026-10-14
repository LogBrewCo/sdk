package logbrew_test

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHTTPClientCanContinueCompletedRequestContext(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(server.Close)
	client := newHTTPTestClient(t)
	transport := newHTTPTestTransport(t, client, newHTTPTestBase(t), false)
	doer := newHTTPTestDoer(transport)
	ctx := newHTTPTestParentContext(t)
	firstResponse := doHTTPTestRequest(t, doer, newHTTPTestRequest(ctx, t, server.URL))
	closeHTTPTestBody(t, firstResponse)
	secondRequest := newHTTPTestRequest(firstResponse.Request.Context(), t, server.URL)
	secondResponse := doHTTPTestRequest(t, doer, secondRequest)

	err := secondResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}

	_, events := previewHTTPTestEvents(t, client, 2)

	first, second := events[0].Attributes, events[1].Attributes
	if first.TraceID != second.TraceID || first.SpanID != second.ParentSpanID || first.SpanID == second.SpanID {
		t.Fatal("continued context lost its child hierarchy")
	}
}
