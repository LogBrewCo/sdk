package logbrew_test

import (
	"net/http"
	"testing"
)

type panicTransport struct{ value any }

func (transport panicTransport) RoundTrip(*http.Request) (*http.Response, error) {
	panic(transport.value)
}

func TestOutboundPanicRetainsFailureSpanAndOriginalValue(t *testing.T) {
	t.Parallel()
	client := newHTTPTestClient(t)
	marker := &struct{ message string }{message: "private panic marker"}
	transport := newHTTPTestTransport(t, client, panicTransport{value: marker}, false)
	ctx := newHTTPTestParentContext(t)
	request := newHTTPTestRequest(ctx, t, "https://example.test/private")
	assertHTTPTestPanic(t, marker, func() {
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}

		if response != nil {
			closeHTTPTestBody(t, response)
		}
	})

	payload, events := previewHTTPTestEvents(t, client, 1)
	if events[0].Attributes.Status != httpTestErrorStatus {
		t.Fatal("transport panic recorded as success")
	}

	assertHTTPTestPrivateMarkers(t, payload, "private panic marker")
}
