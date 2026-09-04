package logbrew

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/http/httptrace"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTraceContextHelpersMergeActiveTraceMetadata(t *testing.T) {
	trace := testTrace(t, "B7AD6B7169203331")
	ctx := ContextWithLogBrewTrace(context.Background(), trace)

	logAttributes := LogAttributesWithTrace(ctx, LogAttributes{
		Message: "checkout started",
		Level:   "info",
		Metadata: map[string]any{
			"component": "checkout",
			"nested":    map[string]any{"drop": true},
		},
	})
	issueAttributes := IssueAttributesWithTrace(ctx, IssueAttributes{
		Title: "Checkout failed",
		Level: "error",
		Metadata: map[string]any{
			"component": "checkout",
		},
	})
	durationMs := 12.5
	spanAttributes, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      trace,
		Name:       "GET /checkout/:cart_id",
		Status:     "ok",
		DurationMs: &durationMs,
		Metadata: map[string]any{
			"routeTemplate": "/checkout/:cart_id",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if logAttributes.Metadata["traceId"] != trace.TraceID ||
		logAttributes.Metadata["spanId"] != trace.SpanID ||
		logAttributes.Metadata["parentSpanId"] != trace.ParentSpanID ||
		logAttributes.Metadata["sampled"] != true {
		t.Fatalf("log metadata missing active trace: %#v", logAttributes.Metadata)
	}
	if _, ok := logAttributes.Metadata["nested"]; ok {
		t.Fatalf("expected non-primitive log metadata to be filtered: %#v", logAttributes.Metadata)
	}
	if issueAttributes.Metadata["traceId"] != trace.TraceID || issueAttributes.Metadata["spanId"] != trace.SpanID {
		t.Fatalf("issue metadata missing active trace: %#v", issueAttributes.Metadata)
	}
	if spanAttributes.TraceID != trace.TraceID ||
		spanAttributes.SpanID != trace.SpanID ||
		spanAttributes.ParentSpanID != trace.ParentSpanID {
		t.Fatalf("span attributes missing active trace: %#v", spanAttributes)
	}
}

func TestHTTPHandlerCorrelatesRequestLogsIssuesSpansAndMetrics(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	now := testNow(25 * time.Millisecond)

	handler, err := NewHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		trace, ok := LogBrewTraceFromContext(r.Context())
		if !ok {
			t.Fatalf("expected active trace context")
		}
		if trace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
			trace.ParentSpanID != "00f067aa0ba902b7" ||
			trace.SpanID != "b7ad6b7169203331" ||
			!trace.Sampled {
			t.Fatalf("unexpected request trace: %#v", trace)
		}
		if err := client.Log("evt_go_http_log", baseTime.Format(time.RFC3339Nano), LogAttributesWithTrace(r.Context(), LogAttributes{
			Message: "checkout handler reached",
			Level:   "info",
			Logger:  "checkout-service",
			Metadata: map[string]any{
				"routeTemplate": "/checkout/:cart_id",
				"nested":        map[string]any{"drop": true},
			},
		})); err != nil {
			t.Fatal(err)
		}
		if err := client.Issue("evt_go_http_issue", baseTime.Format(time.RFC3339Nano), IssueAttributesWithTrace(r.Context(), IssueAttributes{
			Title:   "checkout upstream failed",
			Level:   "error",
			Message: "upstream timeout",
		})); err != nil {
			t.Fatal(err)
		}
		http.Error(w, "upstream failed", http.StatusBadGateway)
	}), HTTPHandlerConfig{
		Client:               client,
		RouteTemplate:        "https://api.example/checkout/:cart_id?coupon=sale#fragment",
		CaptureRequestMetric: true,
		EventIDPrefix:        "go_http_test",
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/checkout/cart_123?coupon=sale", nil)
	request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("unexpected status code: %d", recorder.Code)
	}

	payload, events := previewEvents(t, client)
	if got, want := len(events), 4; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	if got := []string{events[0].Type, events[1].Type, events[2].Type, events[3].Type}; !reflect.DeepEqual(got, []string{"log", "issue", "span", "metric"}) {
		t.Fatalf("unexpected event order: %#v", got)
	}
	logMetadata := events[0].Attributes["metadata"].(map[string]any)
	issueMetadata := events[1].Attributes["metadata"].(map[string]any)
	spanMetadata := events[2].Attributes["metadata"].(map[string]any)
	metricMetadata := events[3].Attributes["metadata"].(map[string]any)
	for name, metadata := range map[string]map[string]any{
		"log":    logMetadata,
		"issue":  issueMetadata,
		"metric": metricMetadata,
	} {
		if metadata["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
			metadata["spanId"] != "b7ad6b7169203331" ||
			metadata["parentSpanId"] != "00f067aa0ba902b7" ||
			metadata["sampled"] != true {
			t.Fatalf("%s metadata missing request trace: %#v", name, metadata)
		}
	}
	if logMetadata["nested"] != nil {
		t.Fatalf("log metadata leaked non-primitive field: %#v", logMetadata)
	}
	if spanMetadata["routeTemplate"] != "/checkout/:cart_id" || spanMetadata["statusCode"] != float64(http.StatusBadGateway) {
		t.Fatalf("unexpected span metadata: %#v", spanMetadata)
	}
	if events[2].Attributes["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		events[2].Attributes["spanId"] != "b7ad6b7169203331" ||
		events[2].Attributes["parentSpanId"] != "00f067aa0ba902b7" ||
		events[2].Attributes["status"] != "error" {
		t.Fatalf("request span is not correlated: %#v", events[2].Attributes)
	}
	if events[3].Attributes["name"] != "http.server.duration" ||
		events[3].Attributes["description"] != "Duration of one completed server request." ||
		events[3].Attributes["kind"] != "histogram" ||
		events[3].Attributes["unit"] != "ms" {
		t.Fatalf("unexpected request duration metric: %#v", events[3].Attributes)
	}
	assertText(t, payload, nil, []string{"coupon=sale", "fragment"})
}

func TestHTTPHandlerFallsBackWhenTraceparentIsMalformed(t *testing.T) {
	client := sampleClient(t)
	handler, err := NewHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := LogBrewTraceFromContext(r.Context()); !ok {
			t.Fatalf("expected fallback trace context")
		}
		w.WriteHeader(http.StatusNoContent)
	}), HTTPHandlerConfig{
		Client:        client,
		RouteTemplate: "/checkout/:cart_id",
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/checkout/cart_123", nil)
	request.Header.Set("traceparent", "malformed-propagation-value")
	handler.ServeHTTP(httptest.NewRecorder(), request)

	payload := previewPayload(t, client)
	assertText(t, payload, []string{`"spanId": "b7ad6b7169203331"`, `"name": "POST /checkout/:cart_id"`}, []string{"malformed-propagation-value"})
}

func TestHTTPHandlerCapturesPanicSpanAndRepanicsWithoutLeakingValue(t *testing.T) {
	client := sampleClient(t)
	now := testNow(17 * time.Millisecond)
	handler, err := NewHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := LogBrewTraceFromContext(r.Context()); !ok {
			t.Fatalf("expected active trace context before panic")
		}
		panic("private checkout panic value")
	}), HTTPHandlerConfig{
		Client:        client,
		RouteTemplate: "/checkout/:cart_id",
		EventIDPrefix: "go_http_panic",
		Metadata: map[string]any{
			"component": "checkout",
			"payload":   "private request body",
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	recovered := capturePanic(func() {
		request := httptest.NewRequest(http.MethodGet, "/checkout/cart_123?coupon=sale", nil)
		request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		handler.ServeHTTP(httptest.NewRecorder(), request)
	})
	if recovered != "private checkout panic value" {
		t.Fatalf("expected original panic value, got %#v", recovered)
	}

	payload := previewPayload(t, client)
	assertText(t, payload, []string{
		`"id": "go_http_panic_span_1"`, `"status": "error"`, `"durationMs": 17`,
		`"statusCode": 500`, `"panic": true`, `"panicType": "string"`, `"component": "checkout"`,
	}, []string{"private checkout panic value", "private request body", "coupon=sale", "traceparent"})
}

func TestHTTPClientTransportInjectsChildTraceAndQueuesSpan(t *testing.T) {
	client := sampleClient(t)
	now := testNow(43 * time.Millisecond)
	parentTrace := testTrace(t, "A7AD6B7169203330")
	ctx := ContextWithLogBrewTrace(context.Background(), parentTrace)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		"https://api.example.test/payments/123?coupon=summer#receipt",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("traceparent", "spoofed")
	request.Header.Set("x-caller", "checkout")
	var sentRequest *http.Request
	var activeTrace TraceContext
	var hasActiveTrace bool
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			sentRequest = cloned
			activeTrace, hasActiveTrace = LogBrewTraceFromContext(cloned.Context())
			return &http.Response{
				StatusCode: http.StatusAccepted,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Request:    cloned,
			}, nil
		}),
		RouteTemplate: "https://api.example.com/payments/:payment_id?coupon=summer#receipt",
		EventIDPrefix: "go_http_client_test",
		Metadata: map[string]any{
			"service": "checkout",
			"headers": map[string]any{"authorization": "private"},
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if sentRequest == nil {
		t.Fatal("expected wrapped transport to receive request")
	}
	if sentRequest == request {
		t.Fatal("expected transport to clone caller request before injecting propagation")
	}
	if request.Header.Get("traceparent") != "spoofed" {
		t.Fatalf("caller traceparent header mutated: %q", request.Header.Get("traceparent"))
	}
	if sentRequest.Header.Get("traceparent") != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01" {
		t.Fatalf("unexpected outgoing traceparent: %q", sentRequest.Header.Get("traceparent"))
	}
	if sentRequest.Header.Get("x-caller") != "checkout" {
		t.Fatalf("caller header not preserved: %#v", sentRequest.Header)
	}
	if !hasActiveTrace ||
		activeTrace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		activeTrace.ParentSpanID != "a7ad6b7169203330" ||
		activeTrace.SpanID != "b7ad6b7169203331" ||
		!activeTrace.Sampled {
		t.Fatalf("unexpected active outbound trace: %#v", activeTrace)
	}

	payload, event := previewEvent(t, client)
	metadata := event.Attributes["metadata"].(map[string]any)
	if event.Type != "span" ||
		event.ID != "go_http_client_test_span_1" ||
		event.Attributes["name"] != "HTTP GET" ||
		event.Attributes["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		event.Attributes["spanId"] != "b7ad6b7169203331" ||
		event.Attributes["parentSpanId"] != "a7ad6b7169203330" ||
		event.Attributes["status"] != "ok" ||
		event.Attributes["durationMs"] != float64(43) {
		t.Fatalf("unexpected outbound span event: %#v", event)
	}
	if metadata["source"] != "net/http.client" ||
		metadata["method"] != "GET" ||
		metadata["host"] != "api.example.test" ||
		metadata["statusCode"] != float64(http.StatusAccepted) ||
		metadata["sampled"] != true {
		t.Fatalf("unexpected outbound metadata: %#v", metadata)
	}
	assertText(t, payload, nil, []string{"coupon=summer", "receipt", "authorization", "traceparent", "spoofed"})
}

func TestHTTPClientTransportIgnoresLegacyPhaseTimingsAndPreservesCallerTrace(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	timestamps := []time.Time{
		baseTime,
		baseTime.Add(2 * time.Millisecond),
		baseTime.Add(7 * time.Millisecond),
		baseTime.Add(11 * time.Millisecond),
		baseTime.Add(18 * time.Millisecond),
		baseTime.Add(20 * time.Millisecond),
		baseTime.Add(24 * time.Millisecond),
		baseTime.Add(31 * time.Millisecond),
		baseTime.Add(46 * time.Millisecond),
		baseTime.Add(52 * time.Millisecond),
	}
	now := func() time.Time {
		if len(timestamps) == 0 {
			t.Fatal("unexpected extra timestamp read")
		}
		current := timestamps[0]
		timestamps = timestamps[1:]
		return current
	}
	parentTrace := testTrace(t, "A7AD6B7169203330")
	var callerTraceCalls []string
	callerTrace := &httptrace.ClientTrace{
		DNSStart: func(info httptrace.DNSStartInfo) {
			callerTraceCalls = append(callerTraceCalls, "dns:"+info.Host)
		},
		WroteRequest: func(httptrace.WroteRequestInfo) {
			callerTraceCalls = append(callerTraceCalls, "wrote")
		},
		GotFirstResponseByte: func() {
			callerTraceCalls = append(callerTraceCalls, "first-byte")
		},
	}
	ctx := httptrace.WithClientTrace(ContextWithLogBrewTrace(context.Background(), parentTrace), callerTrace)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.example.test/payments/123?coupon=summer#receipt", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("traceparent", "spoofed")
	request.Header.Set("authorization", "Bearer private")

	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			trace := httptrace.ContextClientTrace(cloned.Context())
			if trace == nil {
				t.Fatal("expected outbound transport to attach httptrace callbacks")
			}
			trace.DNSStart(httptrace.DNSStartInfo{Host: "api.example.test"})
			trace.WroteRequest(httptrace.WroteRequestInfo{})
			trace.GotFirstResponseByte()
			return &http.Response{
				StatusCode: http.StatusCreated,
				Body:       io.NopCloser(strings.NewReader("created")),
				Request:    cloned,
			}, nil
		}),
		RouteTemplate:       "/payments/:payment_id",
		EventIDPrefix:       "go_http_client_phase",
		CapturePhaseTimings: true,
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := strings.Join(callerTraceCalls, ","); got != "dns:api.example.test,wrote,first-byte" {
		t.Fatalf("caller httptrace hooks were not preserved: %#v", callerTraceCalls)
	}

	payload, event := previewEvent(t, client)
	attributes := event.Attributes
	metadata := attributes["metadata"].(map[string]any)
	if attributes["durationMs"] != float64(2) || metadata["host"] != "api.example.test" {
		t.Fatalf("unexpected phase timing metadata: attributes=%#v metadata=%#v", attributes, metadata)
	}
	assertText(t, payload, nil, []string{"dnsMs", "connectMs", "tlsMs", "wroteRequestMs", "timeToFirstByteMs", "connectionReused", "203.0.113.10", "coupon=summer", "receipt", "authorization", "Bearer private", "traceparent", "spoofed"})
}

func TestHTTPClientTransportCanFinishSpanOnResponseBodyEOF(t *testing.T) {
	client := sampleClient(t)
	now := testNow(80 * time.Millisecond)

	parentTrace := testTrace(t, "A7AD6B7169203330")
	ctx := ContextWithLogBrewTrace(context.Background(), parentTrace)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.example.test/payments/123?coupon=summer#receipt", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("traceparent", "spoofed")
	request.Header.Set("authorization", "Bearer private")

	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("private response body")),
				Request:    cloned,
			}, nil
		}),
		RouteTemplate:                 "/payments/:payment_id",
		EventIDPrefix:                 "go_http_client_body",
		FinishSpanOnResponseBodyClose: true,
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	if got := client.PendingEvents(); got != 0 {
		t.Fatalf("expected body completion to defer span capture, queued %d events", got)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if string(body) != "private response body" {
		t.Fatalf("response body was not preserved: %q", body)
	}

	payload, event := previewEvent(t, client)
	attributes := event.Attributes
	metadata := attributes["metadata"].(map[string]any)
	if attributes["durationMs"] != float64(80) ||
		attributes["status"] != "ok" ||
		metadata["statusCode"] != float64(http.StatusOK) {
		t.Fatalf("unexpected body completion span: attributes=%#v metadata=%#v", attributes, metadata)
	}
	assertText(t, payload, nil, []string{"private response body", "coupon=summer", "receipt", "authorization", "Bearer private", "traceparent", "spoofed"})
}

func TestHTTPClientTransportCanFinishSpanOnResponseBodyClose(t *testing.T) {
	client := sampleClient(t)
	now := testNow(35 * time.Millisecond)

	request := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/payments/123", "a7ad6b7169203330")
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("body not read")),
				Request:    cloned,
			}, nil
		}),
		RouteTemplate:                 "/payments/:payment_id",
		EventIDPrefix:                 "go_http_client_body_close",
		FinishSpanOnResponseBodyClose: true,
		SpanIDFactory: func() string {
			return "b7ad6b7169203332"
		},
		Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	if got := client.PendingEvents(); got != 0 {
		t.Fatalf("expected body close to defer span capture, queued %d events", got)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if got := client.PendingEvents(); got != 1 {
		t.Fatalf("expected one span after close, queued %d events", got)
	}

	payload := previewPayload(t, client)
	assertText(t, payload, []string{`"durationMs": 35`}, []string{"responseBodyCompletion", "body not read"})
}

func TestHTTPClientTransportPreservesHTTPFailuresAndCaptureFailures(t *testing.T) {
	client := sampleClient(t)
	originalError := errors.New("temporary outage")
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
			return nil, originalError
		}),
		EventIDPrefix: "go_http_client_error",
		SpanIDFactory: func() string {
			return "b7ad6b7169203332"
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := mustHTTPClientRequest(t, http.MethodPost, "https://api.example.test/payments/123?coupon=summer", "a7ad6b7169203330")

	response, err := transport.RoundTrip(request)
	if !errors.Is(err, originalError) || response != nil {
		t.Fatalf("expected original transport error, got response=%#v error=%v", response, err)
	}

	payload := previewPayload(t, client)
	assertText(t, payload, []string{`"status": "error"`, `"errorType": "transport"`}, []string{"coupon=summer", "temporary outage"})

	closedClient := sampleClient(t)
	if _, err := closedClient.Shutdown(AlwaysAcceptTransport()); err != nil {
		t.Fatal(err)
	}
	var reported []string
	closedTransport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: closedClient,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusNoContent,
				Body:       io.NopCloser(strings.NewReader("")),
				Request:    cloned,
			}, nil
		}),
		EventIDPrefix: "go_http_client_capture_error",
		SpanIDFactory: func() string {
			return "b7ad6b7169203333"
		},
		OnError: func(err error) {
			reported = append(reported, err.Error())
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	okRequest := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/health", "a7ad6b7169203330")
	okResponse, err := closedTransport.RoundTrip(okRequest)
	if err != nil {
		t.Fatal(err)
	}
	defer okResponse.Body.Close()
	if okResponse.StatusCode != http.StatusNoContent {
		t.Fatalf("unexpected response status: %d", okResponse.StatusCode)
	}
	if len(reported) != 1 || !strings.Contains(reported[0], "client is already shut down") {
		t.Fatalf("expected non-fatal capture error report, got %#v", reported)
	}
}

func TestHTTPClientTransportMarksHTTPClientFailureStatusAsError(t *testing.T) {
	client := sampleClient(t)
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			return &http.Response{
				StatusCode: http.StatusTooManyRequests,
				Body:       io.NopCloser(strings.NewReader("quota exceeded")),
				Request:    cloned,
			}, nil
		}),
		RouteTemplate: "/usage",
		EventIDPrefix: "go_http_client_status_error",
		SpanIDFactory: func() string {
			return "b7ad6b7169203334"
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/usage?debug=true", "a7ad6b7169203330")

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	payload := previewPayload(t, client)
	assertText(t, payload, []string{`"status": "error"`, `"statusCode": 429`}, []string{"debug=true", "quota exceeded"})
}

func TestHTTPClientTransportPassesThroughWhenActiveTraceIsInvalid(t *testing.T) {
	client := sampleClient(t)
	var sentTraceparent string
	var sentRequest *http.Request
	var reported []string
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			sentRequest = cloned
			sentTraceparent = cloned.Header.Get("traceparent")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("ok")),
				Request:    cloned,
			}, nil
		}),
		EventIDPrefix: "go_http_client_malformed_context",
		SpanIDFactory: func() string {
			return "b7ad6b7169203335"
		},
		OnError: func(err error) {
			reported = append(reported, err.Error())
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequestWithContext(
		ContextWithLogBrewTrace(context.Background(), TraceContext{
			TraceID:    "not-a-trace",
			SpanID:     "not-a-span",
			TraceFlags: "zz",
		}),
		http.MethodGet,
		"https://api.example.test/malformed?debug=true",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("traceparent", "caller-owned")

	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if sentRequest != request || sentTraceparent != "caller-owned" || len(reported) != 0 || client.PendingEvents() != 0 {
		t.Fatalf("malformed parent was not a literal pass-through: request=%p sent=%p traceparent=%q reports=%#v events=%d", request, sentRequest, sentTraceparent, reported, client.PendingEvents())
	}
}

func TestSlogHandlerCorrelatesActiveTraceAndPreservesWrappedHandler(t *testing.T) {
	client := sampleClient(t)
	trace := testTrace(t, "B7AD6B7169203331")
	ctx := ContextWithLogBrewTrace(context.Background(), trace)
	var appLog bytes.Buffer
	handler, err := NewSlogHandler(SlogHandlerConfig{
		Client:        client,
		Wrapped:       slog.NewJSONHandler(&appLog, nil),
		Logger:        "checkout-service",
		EventIDPrefix: "go_slog_test",
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(handler)
	logger.WarnContext(ctx, "payment retry", slog.String("cartId", "cart_123"), slog.Any("nested", map[string]any{"drop": true}))

	_, event := previewEvent(t, client)
	attributes := event.Attributes
	metadata := attributes["metadata"].(map[string]any)
	if event.Type != "log" ||
		attributes["message"] != "payment retry" ||
		attributes["level"] != "warning" ||
		attributes["logger"] != "checkout-service" {
		t.Fatalf("unexpected slog event: %#v", event)
	}
	if metadata["source"] != "slog" ||
		metadata["cartId"] != "cart_123" ||
		metadata["traceId"] != trace.TraceID ||
		metadata["spanId"] != trace.SpanID ||
		metadata["parentSpanId"] != trace.ParentSpanID {
		t.Fatalf("slog metadata missing trace correlation: %#v", metadata)
	}
	if metadata["nested"] != nil {
		t.Fatalf("slog metadata leaked non-primitive field: %#v", metadata)
	}
	wrappedOutput := appLog.String()
	if !strings.Contains(wrappedOutput, `"traceId":"4bf92f3577b34da6a3ce929d0e0e4736"`) ||
		!strings.Contains(wrappedOutput, `"spanId":"b7ad6b7169203331"`) ||
		!strings.Contains(wrappedOutput, `"parentSpanId":"00f067aa0ba902b7"`) {
		t.Fatalf("wrapped slog handler did not receive trace fields: %s", wrappedOutput)
	}
}
