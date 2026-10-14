package logbrewotel_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	oteltrace "go.opentelemetry.io/otel/trace"
)

const (
	lifecycleTraceID   = "4bf92f3577b34da6a3ce929d0e0e4736"
	lifecycleParentID  = "00f067aa0ba902b7"
	lifecycleLogSpanID = "b7ad6b7169203331"
	lifecycleTimestamp = "2026-10-04T12:00:00Z"
	lifecycleWaitLimit = 2 * time.Second
)

var lifecycleTime = time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)

type gatedLifecycleSpan struct {
	sdktrace.ReadOnlySpan
	started chan<- struct{}
	release <-chan struct{}
}

func (span gatedLifecycleSpan) Name() string {
	close(span.started)
	<-span.release

	return span.ReadOnlySpan.Name()
}

type lifecycleEvent struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Attributes struct {
		TraceID      string                    `json:"traceId"`
		SpanID       string                    `json:"spanId"`
		ParentSpanID string                    `json:"parentSpanId"`
		Links        []logbrew.SpanLinkSummary `json:"links"`
		Context      *logbrew.TelemetryContext `json:"context"`
		Metadata     struct {
			TraceID string `json:"traceId"`
			SpanID  string `json:"spanId"`
		} `json:"metadata"`
	} `json:"attributes"`
}

func newLifecycleClient(t *testing.T) *logbrew.Client {
	t.Helper()

	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:                "LOGBREW_API_KEY",
		SDKName:               "go-otel-test",
		SDKVersion:            "0.1.0",
		Context:               nil,
		DisableRuntimeContext: true,
		MaxRetries:            2,
		MaxQueueSize:          128,
		OnEventDropped:        nil,
	})
	assertLifecycleResult(t, err)

	return client
}

func lifecycleConfig() logbrewotel.SpanExporterConfig {
	return logbrewotel.SpanExporterConfig{
		EventIDPrefix: "go_otel_test",
		Metadata:      nil,
		Now:           func() time.Time { return lifecycleTime },
	}
}

func newLifecycleExporter(t *testing.T, client *logbrew.Client, config logbrewotel.SpanExporterConfig) *logbrewotel.SpanExporter {
	t.Helper()

	exporter, err := logbrewotel.NewSpanExporter(client, config)
	assertLifecycleResult(t, err)

	return exporter
}

func lifecycleSpans(t *testing.T) []sdktrace.ReadOnlySpan {
	t.Helper()

	traceID, err := oteltrace.TraceIDFromHex(lifecycleTraceID)
	assertLifecycleResult(t, err)
	spanID, err := oteltrace.SpanIDFromHex(lifecycleParentID)
	assertLifecycleResult(t, err)

	parent := oteltrace.NewSpanContext(oteltrace.SpanContextConfig{
		TraceID: traceID, SpanID: spanID, TraceFlags: oteltrace.FlagsSampled,
		TraceState: oteltrace.TraceState{}, Remote: true,
	})
	ctx := oteltrace.ContextWithRemoteSpanContext(t.Context(), parent)
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	tracer := provider.Tracer("checkout-service")

	for _, name := range []string{"first operation", "second operation", "third operation"} {
		_, span := tracer.Start(ctx, name,
			oteltrace.WithLinks(oteltrace.Link{SpanContext: parent, Attributes: nil}),
			oteltrace.WithAttributes(
				attribute.String("http.request.method", "GET"),
				attribute.String("url.full", "https://api.example.test/path?discard=1"),
				attribute.String("db.statement", "discarded statement"),
				attribute.String("exception.message", "discarded detail"),
			),
		)
		span.End()
	}

	assertLifecycleResult(t, provider.Shutdown(t.Context()))

	return recorder.Ended()
}

func writeLifecycleLog(ctx context.Context, client *logbrew.Client, parent oteltrace.SpanContext, id string) error {
	trace, ok, err := logbrewotel.TraceContextFromSpanContext(parent, lifecycleLogSpanID)
	if err != nil {
		return err
	}

	if !ok {
		return fmt.Errorf("missing application trace context")
	}

	return client.LogContext(logbrew.ContextWithLogBrewTrace(ctx, trace), id, lifecycleTimestamp, logbrew.LogAttributes{
		Message: "application operation", Level: "info", Logger: "checkout", Metadata: nil, Context: nil,
	})
}

func writeLifecycleLogs(ctx context.Context, client *logbrew.Client, parent oteltrace.SpanContext, count int) <-chan error {
	results := make(chan error, count)
	for index := range count {
		go func() {
			results <- writeLifecycleLog(ctx, client, parent, fmt.Sprintf("app_log_%d", index))
		}()
	}

	done := make(chan error, 1)
	go func() {
		var first error
		for range count {
			if err := <-results; err != nil && first == nil {
				first = err
			}
		}
		done <- first
	}()

	return done
}

func waitLifecycleSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()

	select {
	case <-signal:
	case <-time.After(lifecycleWaitLimit):
		t.Fatal("span did not reach the export boundary")
	}
}

func waitLifecycleResult(t *testing.T, result <-chan error) error {
	t.Helper()

	select {
	case err := <-result:
		return err
	case <-time.After(lifecycleWaitLimit):
		t.Fatal("export or shutdown exceeded its bounded wait")

		return nil
	}
}

func assertLifecycleResult(t *testing.T, err error) {
	t.Helper()

	if err != nil {
		t.Fatal(err)
	}
}

func lifecycleEvents(t *testing.T, client *logbrew.Client) (string, []lifecycleEvent) {
	t.Helper()

	payload, err := client.PreviewJSON()
	assertLifecycleResult(t, err)

	return payload, decodeLifecycleEvents(t, []byte(payload))
}

func decodeLifecycleEvents(t *testing.T, payload []byte) []lifecycleEvent {
	t.Helper()

	var batch struct {
		Events []lifecycleEvent `json:"events"`
	}
	assertLifecycleResult(t, json.Unmarshal(payload, &batch))

	return batch.Events
}

func assertLifecycleDelivered(t *testing.T, payload []byte, spans []sdktrace.ReadOnlySpan, logs int) {
	t.Helper()

	assertLifecycleEvents(t, decodeLifecycleEvents(t, payload), spans, logs)
	assertLifecyclePrivacy(t, string(payload))
}

func assertLifecycleEvents(t *testing.T, events []lifecycleEvent, spans []sdktrace.ReadOnlySpan, logs int) {
	t.Helper()

	if len(events) != len(spans)+logs {
		t.Fatalf("eligible spans or application logs were lost or duplicated: %d events", len(events))
	}

	ids := make(map[string]bool)
	seen := make(map[string]bool)
	expected := make(map[string]bool)
	for _, span := range spans {
		expected[span.SpanContext().SpanID().String()] = true
	}

	for _, event := range events {
		if ids[event.ID] {
			t.Fatal("event ID was duplicated")
		}
		ids[event.ID] = true
		if event.Type == "span" {
			assertLifecycleSpan(t, event, expected)
			if seen[event.Attributes.SpanID] {
				t.Fatal("an eligible span was queued twice")
			}
			seen[event.Attributes.SpanID] = true
		} else {
			assertLifecycleLog(t, event, expected)
		}
	}

	if len(seen) != len(spans) {
		t.Fatal("exported span count changed")
	}
}

func assertLifecycleSpan(t *testing.T, event lifecycleEvent, expected map[string]bool) {
	t.Helper()

	attributes := event.Attributes
	if !expected[attributes.SpanID] || attributes.TraceID != lifecycleTraceID || attributes.ParentSpanID != lifecycleParentID {
		t.Fatal("exported span trace or parent link changed")
	}

	if len(attributes.Links) != 1 || attributes.Links[0].TraceID != lifecycleTraceID || attributes.Links[0].SpanID != lifecycleParentID {
		t.Fatal("exported span link changed")
	}
}

func assertLifecycleLog(t *testing.T, event lifecycleEvent, expected map[string]bool) {
	t.Helper()

	attributes := event.Attributes
	if event.Type != "log" || attributes.Context == nil || attributes.Context.Trace == nil {
		t.Fatal("application log lost its trace context")
	}

	trace := attributes.Context.Trace
	if trace.TraceID != lifecycleTraceID || trace.SpanID != lifecycleLogSpanID || !expected[trace.ParentSpanID] {
		t.Fatal("application log trace or parent link changed")
	}

	if trace.Sampled == nil || !*trace.Sampled {
		t.Fatal("application log lost the sampled flag")
	}

	if attributes.Metadata.TraceID != trace.TraceID || attributes.Metadata.SpanID != trace.SpanID {
		t.Fatal("application log correlation metadata changed")
	}
}

func assertLifecyclePrivacy(t *testing.T, payload string) {
	t.Helper()

	for _, marker := range []string{"discard=1", "discarded statement", "discarded detail", "api.example.test"} {
		if strings.Contains(payload, marker) {
			t.Fatal("exporter metadata captured an excluded span attribute")
		}
	}
}
