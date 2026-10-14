package logbrew_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	logbrew "github.com/LogBrewCo/sdk/go/logbrew"
)

func TestHTTPClientBodyCloseRecordsCancellation(t *testing.T) {
	t.Parallel()

	for _, reason := range []string{httpTestCancelled, httpTestDeadline} {
		t.Run(reason, func(t *testing.T) {
			t.Parallel()
			server := newPartialHTTPTestServer(t)
			client := newHTTPTestClient(t)
			transport := newHTTPTestTransport(t, client, newHTTPTestBase(t), true)
			parent := newHTTPTestTrace(t)
			ctx, cancel := httpTestCancellationContext(t, parent, reason)
			request := newHTTPTestRequest(ctx, t, server.URL+"/private-path?query-private-marker")
			request.Header.Set("Authorization", "authorization-private-marker")
			response := doHTTPTestRequest(t, newHTTPTestDoer(transport), request)

			_, err := io.ReadFull(response.Body, make([]byte, 4))
			if err != nil {
				t.Fatal(err)
			}

			if client.PendingEvents() != 0 {
				t.Fatal("body span finished before cancellation")
			}

			if reason == httpTestCancelled {
				cancel()
			}

			waitHTTPTestSignal(t, ctx.Done())
			closeHTTPTestBody(t, response)
			payload, events := previewHTTPTestEvents(t, client, 1)
			assertHTTPTestCancellation(t, events[0].Attributes, reason)
			assertHTTPTestChild(t, events[0].Attributes, parent, request)
			assertHTTPTestPrivateMarkers(t, payload, "body-private-marker", "query-private-marker",
				"authorization-private-marker", "private-path", server.URL)
		})
	}
}

func newPartialHTTPTestServer(t *testing.T) *httptest.Server {
	t.Helper()

	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Length", "100")
		_, _ = io.WriteString(writer, "body-private-marker")

		err := http.NewResponseController(writer).Flush()
		if err != nil {
			return
		}

		select {
		case <-request.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(server.Close)
	t.Cleanup(func() { close(release) })

	return server
}

func httpTestCancellationContext(
	t *testing.T,
	parent logbrew.TraceContext,
	reason string,
) (context.Context, context.CancelFunc) {
	t.Helper()
	parentContext := logbrew.ContextWithLogBrewTrace(t.Context(), parent)

	var (
		ctx    context.Context
		cancel context.CancelFunc
	)
	if reason == httpTestDeadline {
		ctx, cancel = context.WithTimeout(parentContext, 200*time.Millisecond)
	} else {
		ctx, cancel = context.WithCancel(parentContext)
	}

	t.Cleanup(cancel)

	return ctx, cancel
}

func assertHTTPTestCancellation(t *testing.T, attributes httpTestAttributes, reason string) {
	t.Helper()

	if attributes.Status != httpTestErrorStatus || attributes.Metadata.ErrorType != reason {
		t.Fatalf("partial response has incorrect outcome: %#v", attributes)
	}

	if reason == httpTestCancelled && !attributes.Metadata.Cancelled {
		t.Fatal("missing cancellation marker")
	}
}

func assertHTTPTestChild(
	t *testing.T,
	attributes httpTestAttributes,
	parent logbrew.TraceContext,
	request *http.Request,
) {
	t.Helper()

	if attributes.TraceID != parent.TraceID ||
		attributes.ParentSpanID != parent.SpanID || attributes.SpanID == parent.SpanID {
		t.Fatal("child correlation changed")
	}

	gotParent, _ := logbrew.LogBrewTraceFromContext(request.Context())
	if gotParent != parent || request.Header.Get("Traceparent") != "" {
		t.Fatal("caller context or header changed")
	}
}

func TestHTTPClientBodyEOFBeforeCancellationRemainsSuccessful(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, "complete response")
	}))
	t.Cleanup(server.Close)
	client := newHTTPTestClient(t)
	transport := newHTTPTestTransport(t, client, newHTTPTestBase(t), true)
	ctx, cancel := context.WithCancel(logbrew.ContextWithLogBrewTrace(t.Context(), newHTTPTestTrace(t)))
	t.Cleanup(cancel)
	response := doHTTPTestRequest(t, newHTTPTestDoer(transport), newHTTPTestRequest(ctx, t, server.URL))

	_, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}

	before, _ := previewHTTPTestEvents(t, client, 1)

	cancel()
	closeHTTPTestBody(t, response)

	after, events := previewHTTPTestEvents(t, client, 1)
	if before != after || events[0].Attributes.Status != "ok" || events[0].Attributes.Metadata.ErrorType != "" {
		t.Fatal("late cancellation rewrote completed response span")
	}
}
