package logbrewotel

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

func TestTraceContextFromOpenTelemetryContextCreatesLogBrewChild(t *testing.T) {
	traceID := mustTraceID(t, "4bf92f3577b34da6a3ce929d0e0e4736")
	spanID := mustSpanID(t, "00f067aa0ba902b7")
	parent := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: oteltrace.FlagsSampled,
		Remote:     true,
	})
	ctx := oteltrace.ContextWithRemoteSpanContext(context.Background(), parent)

	trace, ok, err := TraceContextFromContext(ctx, "b7ad6b7169203331")
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatal("expected active OTel context to produce a LogBrew trace")
	}
	if trace.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		trace.ParentSpanID != "00f067aa0ba902b7" ||
		trace.SpanID != "b7ad6b7169203331" ||
		trace.TraceFlags != "01" ||
		!trace.Sampled {
		t.Fatalf("unexpected copied trace: %#v", trace)
	}

	_, ok, err = TraceContextFromContext(context.Background(), "b7ad6b7169203331")
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("empty context should not produce a LogBrew trace")
	}

	_, _, err = TraceContextFromSpanContext(parent, "not-a-span")
	if err == nil || !strings.Contains(err.Error(), "span id must be 16 hex characters") {
		t.Fatalf("expected LogBrew child span validation, got %v", err)
	}
}

func TestSpanExporterQueuesEndedOpenTelemetrySpansWithSafeMetadata(t *testing.T) {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "go-otel-test",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	exporter, err := NewSpanExporter(client, SpanExporterConfig{
		EventIDPrefix: "go_otel_test",
		Now: func() time.Time {
			return time.Date(2026, 7, 3, 12, 0, 0, 0, time.UTC)
		},
		Metadata: map[string]any{
			"service": "checkout",
			"nested":  map[string]any{"drop": true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)))
	defer func() {
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Fatalf("shutdown provider: %v", err)
		}
	}()

	parent := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID:    mustTraceID(t, "4bf92f3577b34da6a3ce929d0e0e4736"),
		SpanID:     mustSpanID(t, "00f067aa0ba902b7"),
		TraceFlags: oteltrace.FlagsSampled,
		Remote:     true,
	})
	linked := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID:    mustTraceID(t, "11111111111111111111111111111111"),
		SpanID:     mustSpanID(t, "2222222222222222"),
		TraceFlags: 0,
		Remote:     true,
	})
	ctx := oteltrace.ContextWithRemoteSpanContext(context.Background(), parent)
	tracer := provider.Tracer("checkout-service", oteltrace.WithInstrumentationVersion("1.2.3"))
	_, span := tracer.Start(
		ctx,
		"GET /checkout/:cart_id",
		oteltrace.WithSpanKind(oteltrace.SpanKindServer),
		oteltrace.WithAttributes(
			attribute.String("http.request.method", "GET"),
			attribute.String("http.route", "/checkout/:cart_id"),
			attribute.Int("http.response.status_code", 502),
			attribute.String("db.statement", "select * from users where email='user@example.com'"),
			attribute.String("exception.message", "private timeout details"),
			attribute.String("url.full", "https://api.example.test/checkout?debug=true"),
			attribute.String("http.request.header.authorization", "Bearer private"),
		),
		oteltrace.WithLinks(oteltrace.Link{
			SpanContext: linked,
			Attributes: []attribute.KeyValue{
				attribute.String("messaging.system", "nats"),
				attribute.String("url.full", "https://queue.example.test/messages?debug=true"),
			},
		}),
	)
	span.SetStatus(codes.Error, "upstream timeout with private details")
	span.End()

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		Events []struct {
			Type       string         `json:"type"`
			ID         string         `json:"id"`
			Timestamp  string         `json:"timestamp"`
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
	if event.Type != "span" ||
		event.ID != "go_otel_test_span_1" ||
		event.Timestamp != "2026-07-03T12:00:00Z" ||
		event.Attributes["name"] != "GET /checkout/:cart_id" ||
		event.Attributes["traceId"] != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		event.Attributes["parentSpanId"] != "00f067aa0ba902b7" ||
		event.Attributes["status"] != "error" {
		t.Fatalf("unexpected exported span: %#v", event)
	}
	if _, ok := event.Attributes["spanId"].(string); !ok {
		t.Fatalf("missing exported span ID: %#v", event.Attributes)
	}
	if duration, ok := event.Attributes["durationMs"].(float64); !ok || duration < 0 {
		t.Fatalf("expected non-negative duration, got %#v", event.Attributes["durationMs"])
	}
	metadata := event.Attributes["metadata"].(map[string]any)
	if metadata["source"] != "opentelemetry.go" ||
		metadata["service"] != "checkout" ||
		metadata["spanKind"] != "server" ||
		metadata["instrumentationScopeName"] != "checkout-service" ||
		metadata["instrumentationScopeVersion"] != "1.2.3" ||
		metadata["httpMethod"] != "GET" ||
		metadata["httpRoute"] != "/checkout/:cart_id" ||
		metadata["httpStatusCode"] != float64(502) {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	if metadata["nested"] != nil {
		t.Fatalf("expected non-primitive exporter metadata to be filtered: %#v", metadata)
	}
	links := event.Attributes["links"].([]any)
	if len(links) != 1 {
		t.Fatalf("expected one span link, got %#v", links)
	}
	link := links[0].(map[string]any)
	if link["traceId"] != "11111111111111111111111111111111" ||
		link["spanId"] != "2222222222222222" ||
		link["sampled"] != false {
		t.Fatalf("unexpected link summary: %#v", link)
	}
	linkMetadata := link["metadata"].(map[string]any)
	if linkMetadata["messagingSystem"] != "nats" {
		t.Fatalf("unexpected link metadata: %#v", linkMetadata)
	}

	for _, unsafe := range []string{
		"user@example.com",
		"private timeout details",
		"debug=true",
		"authorization",
		"traceparent",
		"queue.example.test",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("exported OTel span leaked %q: %s", unsafe, payload)
		}
	}
}

func mustTraceID(t *testing.T, value string) oteltrace.TraceID {
	t.Helper()
	traceID, err := oteltrace.TraceIDFromHex(value)
	if err != nil {
		t.Fatalf("parse trace ID: %v", err)
	}
	return traceID
}

func mustSpanID(t *testing.T, value string) oteltrace.SpanID {
	t.Helper()
	spanID, err := oteltrace.SpanIDFromHex(value)
	if err != nil {
		t.Fatalf("parse span ID: %v", err)
	}
	return spanID
}
