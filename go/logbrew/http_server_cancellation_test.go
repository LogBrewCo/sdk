package logbrew_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPServerCancelledRequestRecordsFailure(t *testing.T) {
	t.Parallel()
	client := newHTTPTestClient(t)
	started, completed := make(chan struct{}), make(chan struct{})
	handler := newHTTPTestHandler(t, client, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}), true)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		handler.ServeHTTP(writer, request)
		close(completed)
	}))
	t.Cleanup(server.Close)
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	request := newHTTPTestRequest(ctx, t, server.URL+"/private-path?private-query")
	request.Header.Set("Authorization", "private-authorization")
	request.Header.Set("Traceparent", httpTestTraceparent)
	responseDone := startHTTPTestRequest(t, request)
	waitHTTPTestSignal(t, started)
	cancel()
	waitHTTPTestSignal(t, completed)
	waitHTTPTestSignal(t, responseDone)

	payload, events := previewHTTPTestEvents(t, client, 2)
	for _, event := range events {
		if !event.Attributes.Metadata.Cancelled || event.Attributes.Metadata.ErrorType != httpTestCancelled {
			t.Fatalf("cancelled request lost failure classification: %#v", event.Attributes)
		}

		if event.Type == "span" && event.Attributes.Status != httpTestErrorStatus {
			t.Fatal("cancelled request span recorded as success")
		}
	}

	assertHTTPTestPrivateMarkers(t, payload, "private-path", "private-query", "private-authorization", server.URL)
}

func startHTTPTestRequest(t *testing.T, request *http.Request) <-chan struct{} {
	t.Helper()
	client := newHTTPTestDoer(newHTTPTestBase(t))

	done := make(chan struct{})
	go func() {
		defer close(done)

		response, err := client.Do(request)
		if err == nil {
			_ = response.Body.Close()
		}
	}()

	return done
}

func TestHTTPServerDeadlineKeepsHTTPStatusAndClassifiesFailure(t *testing.T) {
	t.Parallel()
	client := newHTTPTestClient(t)
	ctx, cancel := context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
	t.Cleanup(cancel)
	handler := newHTTPTestHandler(t, client, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !errors.Is(request.Context().Err(), context.DeadlineExceeded) {
			t.Fatal("handler deadline changed")
		}

		writer.WriteHeader(http.StatusAccepted)
	}), false)
	request := newHTTPTestRequest(ctx, t, "https://example.test/private")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusAccepted {
		t.Fatal("HTTP status changed")
	}

	_, events := previewHTTPTestEvents(t, client, 1)

	attributes := events[0].Attributes
	if attributes.Status != httpTestErrorStatus || attributes.Metadata.ErrorType != httpTestDeadline ||
		attributes.Metadata.StatusCode != http.StatusAccepted || attributes.Metadata.Cancelled {
		t.Fatal("deadline span has incorrect outcome")
	}
}
