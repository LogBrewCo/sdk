package logbrew

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
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
	request.Header.Set("traceparent", "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01")
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
