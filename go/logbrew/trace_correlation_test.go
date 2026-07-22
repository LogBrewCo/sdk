package logbrew

import (
	"bytes"
	"context"
	"encoding/json"
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
	trace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "B7AD6B7169203331",
	})
	if err != nil {
		t.Fatal(err)
	}
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
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return baseTime
		default:
			return baseTime.Add(25 * time.Millisecond)
		}
	}

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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Type       string         `json:"type"`
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Events), 4; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	if got := []string{parsed.Events[0].Type, parsed.Events[1].Type, parsed.Events[2].Type, parsed.Events[3].Type}; !reflect.DeepEqual(got, []string{"log", "issue", "span", "metric"}) {
		t.Fatalf("unexpected event order: %#v", got)
	}
	logMetadata := parsed.Events[0].Attributes["metadata"].(map[string]any)
	issueMetadata := parsed.Events[1].Attributes["metadata"].(map[string]any)
	spanMetadata := parsed.Events[2].Attributes["metadata"].(map[string]any)
	metricMetadata := parsed.Events[3].Attributes["metadata"].(map[string]any)
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
	if parsed.Events[2].Attributes["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		parsed.Events[2].Attributes["spanId"] != "b7ad6b7169203331" ||
		parsed.Events[2].Attributes["parentSpanId"] != "00f067aa0ba902b7" ||
		parsed.Events[2].Attributes["status"] != "error" {
		t.Fatalf("request span is not correlated: %#v", parsed.Events[2].Attributes)
	}
	if parsed.Events[3].Attributes["name"] != "http.server.duration" ||
		parsed.Events[3].Attributes["kind"] != "histogram" ||
		parsed.Events[3].Attributes["unit"] != "ms" {
		t.Fatalf("unexpected request duration metric: %#v", parsed.Events[3].Attributes)
	}
	if strings.Contains(payload, "coupon=sale") || strings.Contains(payload, "fragment") {
		t.Fatalf("HTTP trace payload leaked query or fragment: %s", payload)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "malformed-propagation-value") {
		t.Fatalf("malformed traceparent leaked into payload: %s", payload)
	}
	if !strings.Contains(payload, `"spanId": "b7ad6b7169203331"`) ||
		!strings.Contains(payload, `"name": "POST /checkout/:cart_id"`) {
		t.Fatalf("expected fallback request span, got: %s", payload)
	}
}

func TestHTTPHandlerCapturesPanicSpanAndRepanicsWithoutLeakingValue(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return baseTime
		default:
			return baseTime.Add(17 * time.Millisecond)
		}
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"id": "go_http_panic_span_1"`) ||
		!strings.Contains(payload, `"status": "error"`) ||
		!strings.Contains(payload, `"durationMs": 17`) ||
		!strings.Contains(payload, `"statusCode": 500`) ||
		!strings.Contains(payload, `"panic": true`) ||
		!strings.Contains(payload, `"panicType": "string"`) ||
		!strings.Contains(payload, `"component": "checkout"`) {
		t.Fatalf("missing panic span metadata: %s", payload)
	}
	for _, unsafe := range []string{"private checkout panic value", "private request body", "coupon=sale", "traceparent"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("panic span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestHTTPClientTransportInjectsChildTraceAndQueuesSpan(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return baseTime
		default:
			return baseTime.Add(43 * time.Millisecond)
		}
	}
	parentTrace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Type       string         `json:"type"`
			ID         string         `json:"id"`
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Events), 1; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	event := parsed.Events[0]
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
	for _, unsafe := range []string{"coupon=summer", "receipt", "authorization", "traceparent", "spoofed"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("outbound span payload leaked %q: %s", unsafe, payload)
		}
	}
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
	parentTrace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Events), 1; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	attributes := parsed.Events[0].Attributes
	metadata := attributes["metadata"].(map[string]any)
	if attributes["durationMs"] != float64(2) || metadata["host"] != "api.example.test" {
		t.Fatalf("unexpected phase timing metadata: attributes=%#v metadata=%#v", attributes, metadata)
	}
	for _, unsafe := range []string{"dnsMs", "connectMs", "tlsMs", "wroteRequestMs", "timeToFirstByteMs", "connectionReused", "203.0.113.10", "coupon=summer", "receipt", "authorization", "Bearer private", "traceparent", "spoofed"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("phase timing span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestHTTPClientTransportCanFinishSpanOnResponseBodyEOF(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return baseTime
		default:
			return baseTime.Add(80 * time.Millisecond)
		}
	}

	parentTrace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Events), 1; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	attributes := parsed.Events[0].Attributes
	metadata := attributes["metadata"].(map[string]any)
	if attributes["durationMs"] != float64(80) ||
		attributes["status"] != "ok" ||
		metadata["statusCode"] != float64(http.StatusOK) {
		t.Fatalf("unexpected body completion span: attributes=%#v metadata=%#v", attributes, metadata)
	}
	for _, unsafe := range []string{"private response body", "coupon=summer", "receipt", "authorization", "Bearer private", "traceparent", "spoofed"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("body completion span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestHTTPClientTransportCanFinishSpanOnResponseBodyClose(t *testing.T) {
	client := sampleClient(t)
	baseTime := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return baseTime
		default:
			return baseTime.Add(35 * time.Millisecond)
		}
	}

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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "responseBodyCompletion") ||
		!strings.Contains(payload, `"durationMs": 35`) ||
		strings.Contains(payload, "body not read") {
		t.Fatalf("unexpected close-completion span payload: %s", payload)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"status": "error"`) ||
		!strings.Contains(payload, `"errorType": "transport"`) ||
		strings.Contains(payload, "coupon=summer") ||
		strings.Contains(payload, "temporary outage") {
		t.Fatalf("unexpected error span payload: %s", payload)
	}

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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"status": "error"`) ||
		!strings.Contains(payload, `"statusCode": 429`) ||
		strings.Contains(payload, "debug=true") ||
		strings.Contains(payload, "quota exceeded") {
		t.Fatalf("unexpected HTTP client status error payload: %s", payload)
	}
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
	trace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "B7AD6B7169203331",
	})
	if err != nil {
		t.Fatal(err)
	}
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

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Type       string         `json:"type"`
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	if got, want := len(parsed.Events), 1; got != want {
		t.Fatalf("unexpected event count: got %d want %d\n%s", got, want, payload)
	}
	attributes := parsed.Events[0].Attributes
	metadata := attributes["metadata"].(map[string]any)
	if parsed.Events[0].Type != "log" ||
		attributes["message"] != "payment retry" ||
		attributes["level"] != "warning" ||
		attributes["logger"] != "checkout-service" {
		t.Fatalf("unexpected slog event: %#v", parsed.Events[0])
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
