package logbrew

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	httpServerTestTraceID      = "4bf92f3577b34da6a3ce929d0e0e4736"
	httpServerTestParentSpanID = "00f067aa0ba902b7"
	httpServerTestSpanID       = "b7ad6b7169203331"
)

var _ = HTTPHandlerConfig{nil, "", false, "", nil, nil, nil, nil}

type httpServerTestEvent struct {
	Type       string         `json:"type"`
	Attributes map[string]any `json:"attributes"`
}

func TestHTTPHandlerUsesMatchedRouteAndContinuesOneTraceparent(t *testing.T) {
	client := sampleClient(t)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /orders/{id}", func(w http.ResponseWriter, r *http.Request) {
		trace, ok := LogBrewTraceFromContext(r.Context())
		if !ok {
			t.Fatal("expected active request trace")
		}
		if trace.TraceID != httpServerTestTraceID ||
			trace.ParentSpanID != httpServerTestParentSpanID ||
			trace.SpanID != httpServerTestSpanID ||
			!trace.Sampled {
			t.Fatalf("unexpected request trace: %#v", trace)
		}
		w.WriteHeader(http.StatusNoContent)
	})

	handler := mustHTTPServerHandler(t, mux, HTTPHandlerConfig{
		Client: client,
		SpanIDFactory: func() string {
			return httpServerTestSpanID
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/orders/opaque-order?marker=opaque-query", nil)
	request.Header.Set("authorization", "Bearer opaque-auth")
	request.Header.Set("cookie", "session=opaque-cookie")
	request.Header.Set("traceparent", "00-"+httpServerTestTraceID+"-"+httpServerTestParentSpanID+"-01")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	events, payload := previewHTTPServerEvents(t, client)
	if len(events) != 1 || events[0].Type != "span" {
		t.Fatalf("expected one server span, got %#v", events)
	}
	span := events[0].Attributes
	metadata := span["metadata"].(map[string]any)
	if span["name"] != "GET /orders/{id}" ||
		span["traceId"] != httpServerTestTraceID ||
		span["parentSpanId"] != httpServerTestParentSpanID ||
		span["spanId"] != httpServerTestSpanID ||
		span["status"] != "ok" ||
		metadata["method"] != http.MethodGet ||
		metadata["routeTemplate"] != "/orders/{id}" ||
		metadata["statusCode"] != float64(http.StatusNoContent) {
		t.Fatalf("unexpected server span: %#v", span)
	}
	assertHTTPServerPayloadPrivate(t, payload,
		"opaque-order", "opaque-query", "opaque-auth", "opaque-cookie", "traceparent")
}

func TestHTTPHandlerRejectsDuplicateTraceparentWithoutLeakingIt(t *testing.T) {
	client := sampleClient(t)
	var reported []string
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace, ok := LogBrewTraceFromContext(r.Context())
		if !ok {
			t.Fatal("expected fallback request trace")
		}
		if trace.TraceID == httpServerTestTraceID || trace.ParentSpanID != "" {
			t.Fatalf("duplicate propagation was trusted: %#v", trace)
		}
		w.WriteHeader(http.StatusAccepted)
	}), HTTPHandlerConfig{
		Client: client,
		SpanIDFactory: func() string {
			return httpServerTestSpanID
		},
		OnError: func(err error) {
			reported = append(reported, err.Error())
		},
	})
	request := httptest.NewRequest(http.MethodPost, "/opaque-path", nil)
	request.Header.Add("traceparent", "00-"+httpServerTestTraceID+"-"+httpServerTestParentSpanID+"-01")
	request.Header.Add("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if !reflect.DeepEqual(reported, []string{"capture_error: HTTP traceparent skipped"}) {
		t.Fatalf("unexpected traceparent diagnostic: %#v", reported)
	}
	_, payload := previewHTTPServerEvents(t, client)
	assertHTTPServerPayloadPrivate(t, payload, "opaque-path", "traceparent", httpServerTestParentSpanID)
}

func TestHTTPHandlerUsesStrictW3CWireTraceparentValidation(t *testing.T) {
	tests := []struct {
		name             string
		traceparent      string
		wantParentSpanID string
		wantDiagnostic   bool
	}{
		{
			name:             "future version extension",
			traceparent:      "01-" + httpServerTestTraceID + "-" + httpServerTestParentSpanID + "-01-extra",
			wantParentSpanID: httpServerTestParentSpanID,
		},
		{
			name:           "uppercase wire ids",
			traceparent:    "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
			wantDiagnostic: true,
		},
		{
			name:           "version zero extension",
			traceparent:    "00-" + httpServerTestTraceID + "-" + httpServerTestParentSpanID + "-01-extra",
			wantDiagnostic: true,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := sampleClient(t)
			var reported []string
			handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusNoContent)
			}), HTTPHandlerConfig{
				Client: client,
				OnError: func(err error) {
					reported = append(reported, err.Error())
				},
			})
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.Header.Set("traceparent", test.traceparent)
			handler.ServeHTTP(httptest.NewRecorder(), request)
			events, payload := previewHTTPServerEvents(t, client)
			parentSpanID, _ := events[0].Attributes["parentSpanId"].(string)
			if parentSpanID != test.wantParentSpanID {
				t.Fatalf("unexpected parent span id: got %q want %q", parentSpanID, test.wantParentSpanID)
			}
			if (len(reported) == 1) != test.wantDiagnostic {
				t.Fatalf("unexpected diagnostics: %#v", reported)
			}
			assertHTTPServerPayloadPrivate(t, payload, test.traceparent, "traceparent")
		})
	}
}

func TestHTTPHandlerCreatesStandardsCorrectIDsWithoutPropagation(t *testing.T) {
	client := sampleClient(t)
	var active TraceContext
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var ok bool
		active, ok = LogBrewTraceFromContext(r.Context())
		if !ok {
			t.Fatal("expected generated request trace")
		}
		w.WriteHeader(http.StatusOK)
	}), HTTPHandlerConfig{Client: client})
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	if err := requireTraceID(active.TraceID); err != nil {
		t.Fatalf("invalid generated trace id: %v", err)
	}
	if err := requireSpanID("span id", active.SpanID); err != nil {
		t.Fatalf("invalid generated span id: %v", err)
	}
	if active.ParentSpanID != "" || active.TraceFlags != "00" || active.Sampled {
		t.Fatalf("unexpected generated trace: %#v", active)
	}
}

func TestHTTPHandlerPreservesCancellationAndDeadline(t *testing.T) {
	client := sampleClient(t)
	deadline := time.Now().Add(time.Minute)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	cancel()
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotDeadline, ok := r.Context().Deadline()
		if !ok || !gotDeadline.Equal(deadline) {
			t.Fatalf("request deadline changed: %v %v", gotDeadline, ok)
		}
		if !errors.Is(r.Context().Err(), context.Canceled) {
			t.Fatalf("request cancellation changed: %v", r.Context().Err())
		}
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{Client: client})
	request := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx)
	handler.ServeHTTP(httptest.NewRecorder(), request)
}

func TestHTTPHandlerCapturesCorrelatedPanicIssueAndRepanics(t *testing.T) {
	client := sampleClient(t)
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		panic(errors.New("opaque panic value"))
	}), HTTPHandlerConfig{
		Client: client,
		SpanIDFactory: func() string {
			return httpServerTestSpanID
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/panic/opaque-id?marker=value", nil)
	request.Header.Set("traceparent", "00-"+httpServerTestTraceID+"-"+httpServerTestParentSpanID+"-01")
	recovered := capturePanic(func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
	})
	if recovered == nil || recovered.(error).Error() != "opaque panic value" {
		t.Fatalf("original panic was not kept: %#v", recovered)
	}

	events, payload := previewHTTPServerEvents(t, client)
	if got := eventTypes(events); !reflect.DeepEqual(got, []string{"span", "issue"}) {
		t.Fatalf("expected correlated panic span and issue, got %#v", got)
	}
	span := events[0].Attributes
	issue := events[1].Attributes
	issueMetadata := issue["metadata"].(map[string]any)
	if span["status"] != "error" ||
		issue["title"] != "HTTP server panic" ||
		issue["level"] != "error" ||
		issueMetadata["traceId"] != httpServerTestTraceID ||
		issueMetadata["spanId"] != httpServerTestSpanID ||
		issueMetadata["parentSpanId"] != httpServerTestParentSpanID {
		t.Fatalf("panic telemetry is not correlated: %#v %#v", span, issue)
	}
	assertHTTPServerPayloadPrivate(t, payload, "opaque panic value", "opaque-id", "marker=value")
}

func TestHTTPHandlerKeepsOriginalPanicWhenTelemetryCallbackPanics(t *testing.T) {
	client := sampleClient(t)
	var nowCalls atomic.Int64
	var diagnostics atomic.Int64
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
		panic("original application panic")
	}), HTTPHandlerConfig{
		Client: client,
		Now: func() time.Time {
			if nowCalls.Add(1) > 1 {
				panic("opaque telemetry clock panic")
			}
			return time.Unix(1_700_000_000, 0)
		},
		OnError: func(err error) {
			if err == nil || err.Error() != "capture_error: HTTP request telemetry skipped" {
				t.Fatalf("unexpected telemetry diagnostic: %v", err)
			}
			diagnostics.Add(1)
		},
	})
	if recovered := capturePanic(func() {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
	}); recovered != "original application panic" {
		t.Fatalf("telemetry callback replaced app panic: %#v", recovered)
	}
	if diagnostics.Load() != 1 {
		t.Fatalf("expected one bounded diagnostic, got %d", diagnostics.Load())
	}
}

func TestHTTPHandlerServesRequestWhenTelemetryInitializationPanics(t *testing.T) {
	client := sampleClient(t)
	var diagnostics atomic.Int64
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{
		Client: client,
		SpanIDFactory: func() string {
			panic("opaque span id callback panic")
		},
		OnError: func(err error) {
			if err == nil || err.Error() != "capture_error: HTTP request telemetry skipped" {
				t.Fatalf("unexpected telemetry diagnostic: %v", err)
			}
			diagnostics.Add(1)
		},
	})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusNoContent || diagnostics.Load() != 1 {
		t.Fatalf("telemetry initialization changed serving: status=%d diagnostics=%d", recorder.Code, diagnostics.Load())
	}
	events, payload := previewHTTPServerEvents(t, client)
	if len(events) != 0 {
		t.Fatalf("failed initialization emitted telemetry: %#v", events)
	}
	assertHTTPServerPayloadPrivate(t, payload, "opaque span id callback panic")
}

func TestHTTPHandlerKeepsOriginalPanicWhenDiagnosticCallbackPanics(t *testing.T) {
	client := sampleClient(t)
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("original application panic")
	}), HTTPHandlerConfig{
		Client: client,
		OnError: func(error) {
			panic("diagnostic callback panic")
		},
	})
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("traceparent", "invalid-opaque-traceparent")
	if recovered := capturePanic(func() {
		handler.ServeHTTP(httptest.NewRecorder(), request)
	}); recovered != "original application panic" {
		t.Fatalf("diagnostic callback replaced app panic: %#v", recovered)
	}
}

func TestHTTPHandlerOrdinary5xxIssueRequiresExplicitOption(t *testing.T) {
	for _, test := range []struct {
		name          string
		captureIssue  bool
		expectedTypes []string
	}{
		{name: "span only by default", expectedTypes: []string{"span"}},
		{name: "bounded issue when enabled", captureIssue: true, expectedTypes: []string{"span", "issue"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := sampleClient(t)
			handler := mustHTTPServerHandlerWithOptions(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "opaque upstream response", http.StatusServiceUnavailable)
			}), HTTPHandlerConfig{
				Client: client,
			}, httpServerErrorIssueOption(test.captureIssue)...)
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/opaque-resource", nil))
			events, payload := previewHTTPServerEvents(t, client)
			if got := eventTypes(events); !reflect.DeepEqual(got, test.expectedTypes) {
				t.Fatalf("unexpected event types: got %#v want %#v", got, test.expectedTypes)
			}
			if events[0].Attributes["status"] != "error" {
				t.Fatalf("5xx span was not marked error: %#v", events[0])
			}
			if test.captureIssue && events[1].Attributes["title"] != "HTTP server error response" {
				t.Fatalf("unexpected 5xx issue: %#v", events[1])
			}
			assertHTTPServerPayloadPrivate(t, payload, "opaque upstream response", "opaque-resource")
		})
	}
}

func TestHTTPHandlerOptionsRejectNilWithoutChangingStableConfig(t *testing.T) {
	client := sampleClient(t)
	_, err := NewHTTPHandlerWithOptions(http.NotFoundHandler(), HTTPHandlerConfig{Client: client}, nil)
	if err == nil || err.Error() != "configuration_error: HTTP handler option must be non-nil" {
		t.Fatalf("unexpected nil option result: %v", err)
	}
	handler, err := NewHTTPHandlerFuncWithOptions(
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) },
		HTTPHandlerConfig{Client: client},
		WithHTTPServerErrorIssues(),
	)
	if err != nil {
		t.Fatalf("create handler func with options: %v", err)
	}
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
}

func TestHTTPHandlerOutermostWrapperOwnsNestedInstrumentation(t *testing.T) {
	client := sampleClient(t)
	inner := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace, ok := LogBrewTraceFromContext(r.Context())
		if !ok || trace.SpanID != "aaaaaaaaaaaaaaaa" {
			t.Fatalf("inner handler did not preserve outer trace: %#v", trace)
		}
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{
		Client:        client,
		EventIDPrefix: "inner",
		SpanIDFactory: func() string { return "bbbbbbbbbbbbbbbb" },
	})
	outer := mustHTTPServerHandler(t, inner, HTTPHandlerConfig{
		Client:        client,
		EventIDPrefix: "outer",
		SpanIDFactory: func() string { return "aaaaaaaaaaaaaaaa" },
	})
	outer.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))

	events, _ := previewHTTPServerEvents(t, client)
	if len(events) != 1 || events[0].Type != "span" || events[0].Attributes["spanId"] != "aaaaaaaaaaaaaaaa" {
		t.Fatalf("nested middleware emitted duplicate or unstable telemetry: %#v", events)
	}
}

func TestHTTPHandlerSnapshotsConfigurationAndNeverUsesRawPathFallback(t *testing.T) {
	client := sampleClient(t)
	metadata := map[string]any{
		"component": "checkout",
		"body":      "opaque configured body",
	}
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{Client: client, Metadata: metadata})
	metadata["component"] = "mutated-opaque-component"
	metadata["marker"] = "mutated-opaque-marker"

	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("OPAQUE-METHOD", "/users/opaque-user?marker=opaque-query", nil))
	events, payload := previewHTTPServerEvents(t, client)
	span := events[0].Attributes
	spanMetadata := span["metadata"].(map[string]any)
	if span["name"] != "OTHER /" ||
		spanMetadata["method"] != "OTHER" ||
		spanMetadata["routeTemplate"] != "/" ||
		spanMetadata["component"] != "checkout" {
		t.Fatalf("unexpected privacy-bounded span: %#v", span)
	}
	assertHTTPServerPayloadPrivate(t, payload,
		"OPAQUE-METHOD", "opaque-user", "opaque-query", "opaque configured body",
		"mutated-opaque-component", "mutated-opaque-marker")
}

func TestHTTPHandlerPreservesOptionalResponseWriterInterfaces(t *testing.T) {
	client := sampleClient(t)
	full := newHTTPServerFullWriter()
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		flusher, hasFlusher := w.(http.Flusher)
		hijacker, hasHijacker := w.(http.Hijacker)
		pusher, hasPusher := w.(http.Pusher)
		readerFrom, hasReaderFrom := w.(io.ReaderFrom)
		if !hasFlusher || !hasHijacker || !hasPusher || !hasReaderFrom {
			t.Fatalf("optional interfaces were lost: flush=%v hijack=%v push=%v readFrom=%v", hasFlusher, hasHijacker, hasPusher, hasReaderFrom)
		}
		if _, err := readerFrom.ReadFrom(&httpServerReaderOnly{reader: strings.NewReader("stream")}); err != nil {
			t.Fatal(err)
		}
		flusher.Flush()
		if err := pusher.Push("/asset", nil); err != nil {
			t.Fatal(err)
		}
		if _, _, err := hijacker.Hijack(); err != nil {
			t.Fatal(err)
		}
	}), HTTPHandlerConfig{Client: client})
	handler.ServeHTTP(full, httptest.NewRequest(http.MethodGet, "/", nil))
	if !full.flushed || !full.hijacked || !full.pushed || !full.readFrom || full.status != http.StatusOK || full.body.String() != "stream" {
		t.Fatalf("optional interface semantics changed: %#v", full)
	}

	plain := &httpServerPlainWriter{header: make(http.Header)}
	plainHandler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			t.Fatal("wrapper advertised unsupported Flusher")
		}
		if _, ok := w.(http.Hijacker); ok {
			t.Fatal("wrapper advertised unsupported Hijacker")
		}
		if _, ok := w.(http.Pusher); ok {
			t.Fatal("wrapper advertised unsupported Pusher")
		}
		if _, ok := w.(io.ReaderFrom); ok {
			t.Fatal("wrapper advertised unsupported ReaderFrom")
		}
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{Client: sampleClient(t)})
	plainHandler.ServeHTTP(plain, httptest.NewRequest(http.MethodGet, "/", nil))
}

func TestHTTPHandlerPreservesImplicitWriteAndFlushErrorSemantics(t *testing.T) {
	client := sampleClient(t)
	recorder := httptest.NewRecorder()
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "<html><body>ok</body></html>")
	}), HTTPHandlerConfig{Client: client})
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if contentType := recorder.Header().Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Fatalf("implicit content type detection changed: %q", contentType)
	}

	flushErr := errors.New("flush failed")
	writer := &httpServerFlushErrorWriter{header: make(http.Header), err: flushErr}
	flushHandler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := http.NewResponseController(w).Flush(); !errors.Is(err, flushErr) {
			t.Fatalf("flush error was lost: %v", err)
		}
	}), HTTPHandlerConfig{Client: sampleClient(t)})
	flushHandler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))
}

func TestHTTPResponseWriterPreservesExactOptionalInterfaceMatrix(t *testing.T) {
	for mask := 0; mask < 16; mask++ {
		underlying := httpServerWriterWithInterfaces(mask)
		recorder := newStatusRecordingResponseWriter(underlying)
		wrapped := wrapStatusRecordingResponseWriter(underlying, recorder)
		got := 0
		if _, ok := wrapped.(http.Flusher); ok {
			got |= 1
		}
		if _, ok := wrapped.(http.Hijacker); ok {
			got |= 2
		}
		if _, ok := wrapped.(http.Pusher); ok {
			got |= 4
		}
		if _, ok := wrapped.(io.ReaderFrom); ok {
			got |= 8
		}
		if got != mask {
			t.Fatalf("optional interface mask changed: got %04b want %04b", got, mask)
		}
		unwrapper, ok := wrapped.(interface{ Unwrap() http.ResponseWriter })
		if !ok || unwrapper.Unwrap() != underlying {
			t.Fatalf("response controller unwrap changed for mask %04b", mask)
		}
	}
}

func TestHTTPHandlerRecordsFinalStatusAfterInformationalResponse(t *testing.T) {
	client := sampleClient(t)
	writer := &httpServerPlainWriter{header: make(http.Header)}
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusEarlyHints)
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{Client: client})
	handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))

	if !reflect.DeepEqual(writer.statuses, []int{http.StatusEarlyHints, http.StatusNoContent}) {
		t.Fatalf("informational response semantics changed: %#v", writer.statuses)
	}
	events, _ := previewHTTPServerEvents(t, client)
	metadata := events[0].Attributes["metadata"].(map[string]any)
	if metadata["statusCode"] != float64(http.StatusNoContent) {
		t.Fatalf("final status was not recorded: %#v", metadata)
	}
}

func TestHTTPHandlerHandlesConcurrentRequestsWithoutSharedTraceState(t *testing.T) {
	client := sampleClient(t)
	handler := mustHTTPServerHandler(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := LogBrewTraceFromContext(r.Context()); !ok {
			t.Fatal("missing concurrent request trace")
		}
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{Client: client})

	const requests = 64
	var wait sync.WaitGroup
	wait.Add(requests)
	for index := 0; index < requests; index++ {
		go func() {
			defer wait.Done()
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
		}()
	}
	wait.Wait()
	events, _ := previewHTTPServerEvents(t, client)
	if len(events) != requests {
		t.Fatalf("unexpected concurrent span count: %d", len(events))
	}
	traceIDs := make(map[string]struct{}, requests)
	spanIDs := make(map[string]struct{}, requests)
	for _, event := range events {
		traceIDs[event.Attributes["traceId"].(string)] = struct{}{}
		spanIDs[event.Attributes["spanId"].(string)] = struct{}{}
	}
	if len(traceIDs) != requests || len(spanIDs) != requests {
		t.Fatalf("concurrent requests shared trace state: traces=%d spans=%d", len(traceIDs), len(spanIDs))
	}
}

func mustHTTPServerHandler(t *testing.T, next http.Handler, config HTTPHandlerConfig) http.Handler {
	t.Helper()
	handler, err := NewHTTPHandler(next, config)
	if err != nil {
		t.Fatalf("create HTTP handler: %v", err)
	}
	return handler
}

func mustHTTPServerHandlerWithOptions(
	t *testing.T,
	next http.Handler,
	config HTTPHandlerConfig,
	options ...HTTPHandlerOption,
) http.Handler {
	t.Helper()
	handler, err := NewHTTPHandlerWithOptions(next, config, options...)
	if err != nil {
		t.Fatalf("create HTTP handler with options: %v", err)
	}
	return handler
}

func httpServerErrorIssueOption(enabled bool) []HTTPHandlerOption {
	if !enabled {
		return nil
	}
	return []HTTPHandlerOption{WithHTTPServerErrorIssues()}
}

func previewHTTPServerEvents(t *testing.T, client *Client) ([]httpServerTestEvent, string) {
	t.Helper()
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		Events []httpServerTestEvent `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Events, payload
}

func eventTypes(events []httpServerTestEvent) []string {
	types := make([]string, 0, len(events))
	for _, event := range events {
		types = append(types, event.Type)
	}
	return types
}

func assertHTTPServerPayloadPrivate(t *testing.T, payload string, forbidden ...string) {
	t.Helper()
	for _, value := range forbidden {
		if strings.Contains(payload, value) {
			t.Fatalf("HTTP server telemetry leaked %q: %s", value, payload)
		}
	}
}

type httpServerPlainWriter struct {
	header   http.Header
	statuses []int
	status   int
	body     bytes.Buffer
}

type httpServerFlushErrorWriter struct {
	header http.Header
	err    error
}

func (w *httpServerFlushErrorWriter) Header() http.Header { return w.header }

func (w *httpServerFlushErrorWriter) Write(data []byte) (int, error) { return len(data), nil }

func (w *httpServerFlushErrorWriter) WriteHeader(int) {}

func (w *httpServerFlushErrorWriter) Flush() {}

func (w *httpServerFlushErrorWriter) FlushError() error { return w.err }

func (w *httpServerPlainWriter) Header() http.Header {
	return w.header
}

func (w *httpServerPlainWriter) WriteHeader(status int) {
	w.statuses = append(w.statuses, status)
	if status < 100 || status > 199 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
}

func (w *httpServerPlainWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.body.Write(data)
}

type httpServerFullWriter struct {
	*httpServerPlainWriter
	flushed  bool
	hijacked bool
	pushed   bool
	readFrom bool
}

func newHTTPServerFullWriter() *httpServerFullWriter {
	return &httpServerFullWriter{httpServerPlainWriter: &httpServerPlainWriter{header: make(http.Header)}}
}

func (w *httpServerFullWriter) Flush() {
	w.flushed = true
}

func (w *httpServerFullWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	w.hijacked = true
	return nil, nil, nil
}

func (w *httpServerFullWriter) Push(string, *http.PushOptions) error {
	w.pushed = true
	return nil
}

func (w *httpServerFullWriter) ReadFrom(reader io.Reader) (int64, error) {
	w.readFrom = true
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.body.ReadFrom(reader)
}

type httpServerReaderOnly struct {
	reader io.Reader
}

func (r *httpServerReaderOnly) Read(data []byte) (int, error) {
	return r.reader.Read(data)
}

func httpServerWriterWithInterfaces(mask int) http.ResponseWriter {
	full := newHTTPServerFullWriter()
	core := http.ResponseWriter(full)
	flusher := http.Flusher(full)
	hijacker := http.Hijacker(full)
	pusher := http.Pusher(full)
	readerFrom := io.ReaderFrom(full)
	switch mask {
	case 1:
		return struct {
			http.ResponseWriter
			http.Flusher
		}{core, flusher}
	case 2:
		return struct {
			http.ResponseWriter
			http.Hijacker
		}{core, hijacker}
	case 3:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Hijacker
		}{core, flusher, hijacker}
	case 4:
		return struct {
			http.ResponseWriter
			http.Pusher
		}{core, pusher}
	case 5:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Pusher
		}{core, flusher, pusher}
	case 6:
		return struct {
			http.ResponseWriter
			http.Hijacker
			http.Pusher
		}{core, hijacker, pusher}
	case 7:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Hijacker
			http.Pusher
		}{core, flusher, hijacker, pusher}
	case 8:
		return struct {
			http.ResponseWriter
			io.ReaderFrom
		}{core, readerFrom}
	case 9:
		return struct {
			http.ResponseWriter
			http.Flusher
			io.ReaderFrom
		}{core, flusher, readerFrom}
	case 10:
		return struct {
			http.ResponseWriter
			http.Hijacker
			io.ReaderFrom
		}{core, hijacker, readerFrom}
	case 11:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Hijacker
			io.ReaderFrom
		}{core, flusher, hijacker, readerFrom}
	case 12:
		return struct {
			http.ResponseWriter
			http.Pusher
			io.ReaderFrom
		}{core, pusher, readerFrom}
	case 13:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Pusher
			io.ReaderFrom
		}{core, flusher, pusher, readerFrom}
	case 14:
		return struct {
			http.ResponseWriter
			http.Hijacker
			http.Pusher
			io.ReaderFrom
		}{core, hijacker, pusher, readerFrom}
	case 15:
		return struct {
			http.ResponseWriter
			http.Flusher
			http.Hijacker
			http.Pusher
			io.ReaderFrom
		}{core, flusher, hijacker, pusher, readerFrom}
	default:
		return struct{ http.ResponseWriter }{core}
	}
}
