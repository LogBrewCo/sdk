package logbrew

import (
	"encoding/json"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

func TestRuntimeContextDefaultsEveryEventType(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)
	if err := client.Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
		Name: "checkout.requests", Kind: "counter", Value: 1, Unit: "{request}", Temporality: "delta",
	}); err != nil {
		t.Fatal(err)
	}

	var payload struct {
		Events []struct {
			Type       string         `json:"type"`
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	preview, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}

	expected := map[string]any{
		"schemaVersion": float64(1),
		"resource": map[string]any{
			"runtime":         map[string]any{"name": "go", "version": runtime.Version()},
			"operatingSystem": map[string]any{"name": runtime.GOOS},
			"device":          map[string]any{"architecture": runtime.GOARCH},
		},
	}
	if len(payload.Events) != 7 {
		t.Fatalf("expected seven event types, got %d", len(payload.Events))
	}
	for _, event := range payload.Events {
		if !reflect.DeepEqual(event.Attributes["context"], expected) {
			t.Fatalf("%s context mismatch: got %#v want %#v", event.Type, event.Attributes["context"], expected)
		}
	}
	if strings.Contains(preview, "LOGBREW_SERVER_API_KEY") || strings.Contains(preview, "LOGBREW_API_KEY") {
		t.Fatalf("runtime context leaked configuration values: %s", preview)
	}
}

func TestClientAndEventContextsMergeAndDetachInputs(t *testing.T) {
	clientContext := &TelemetryContext{
		SchemaVersion: 1,
		Resource: &TelemetryResource{
			Service: &TelemetryNamedVersion{Name: "checkout-api", Version: "1.4.0"},
			Runtime: &TelemetryNamedVersion{Name: "custom-go", Version: "1.24.0"},
			Device:  &TelemetryDevice{Model: "container"},
		},
		Trace: &TelemetryTraceContext{
			TraceID: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
			SpanID:  "BBBBBBBBBBBBBBBB",
			Sampled: boolPtr(true),
		},
		Session: &TelemetrySessionContext{ID: "session_01", PreviousID: "session_00"},
		Tags:    map[string]string{"plan": "team", "region": "eu"},
	}
	eventContext := &TelemetryContext{
		SchemaVersion: 1,
		Resource: &TelemetryResource{
			Service:     &TelemetryNamedVersion{Name: "checkout-api", Version: "1.5.0"},
			Device:      &TelemetryDevice{Architecture: "wasm32"},
			Application: &TelemetryApplication{Name: "checkout-worker", Build: "20260803.1"},
		},
		Trace: &TelemetryTraceContext{
			TraceID:      "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
			ParentSpanID: "DDDDDDDDDDDDDDDD",
		},
		Subject: &TelemetrySubjectContext{ID: "user_42", Kind: "user"},
		Tags:    map[string]string{"feature": "one-click", "plan": "enterprise"},
	}
	client, err := NewClient(Config{
		APIKey:                "LOGBREW_API_KEY",
		SDKName:               "logbrew-go",
		SDKVersion:            "0.1.0",
		Context:               clientContext,
		DisableRuntimeContext: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_context", "2026-08-03T00:00:00Z", LogAttributes{
		Message: "checkout failed", Level: "error", Context: eventContext,
	}); err != nil {
		t.Fatal(err)
	}

	clientContext.Resource.Service.Version = "mutated"
	clientContext.Tags["region"] = "mutated"
	eventContext.Resource.Application.Name = "mutated"
	eventContext.Tags["feature"] = "mutated"

	context := previewEventContext(t, client)
	expected := map[string]any{
		"schemaVersion": float64(1),
		"resource": map[string]any{
			"service":     map[string]any{"name": "checkout-api", "version": "1.5.0"},
			"runtime":     map[string]any{"name": "custom-go", "version": "1.24.0"},
			"device":      map[string]any{"model": "container", "architecture": "wasm32"},
			"application": map[string]any{"name": "checkout-worker", "build": "20260803.1"},
		},
		"trace": map[string]any{
			"traceId":      "cccccccccccccccccccccccccccccccc",
			"parentSpanId": "dddddddddddddddd",
		},
		"session": map[string]any{"id": "session_01", "previousId": "session_00"},
		"subject": map[string]any{"id": "user_42", "kind": "user"},
		"tags": map[string]any{
			"feature": "one-click", "plan": "enterprise", "region": "eu",
		},
	}
	if !reflect.DeepEqual(context, expected) {
		t.Fatalf("merged context mismatch: got %#v want %#v", context, expected)
	}
}

func TestPublicTelemetryContextHelpersNormalizeMergeAndDetach(t *testing.T) {
	base := &TelemetryContext{
		SchemaVersion: 1,
		Resource: &TelemetryResource{
			Service: &TelemetryNamedVersion{Name: " checkout-api ", Version: "1.4.0"},
		},
		Tags: map[string]string{"plan": " team "},
	}
	normalized, err := ValidateTelemetryContext(base)
	if err != nil {
		t.Fatal(err)
	}
	base.Resource.Service.Name = "mutated"
	base.Tags["plan"] = "mutated"
	if normalized.Resource.Service.Name != "checkout-api" || normalized.Tags["plan"] != "team" {
		t.Fatalf("public validation did not normalize and detach: %#v", normalized)
	}

	override := &TelemetryContext{
		SchemaVersion: 1,
		Resource: &TelemetryResource{
			Service: &TelemetryNamedVersion{Name: "checkout-api", Version: "1.5.0"},
		},
		Tags: map[string]string{"operation": "checkout"},
	}
	merged, err := MergeTelemetryContexts(normalized, override)
	if err != nil {
		t.Fatal(err)
	}
	override.Resource.Service.Version = "mutated"
	override.Tags["operation"] = "mutated"
	if merged.Resource.Service.Version != "1.5.0" ||
		!reflect.DeepEqual(merged.Tags, map[string]string{"operation": "checkout", "plan": "team"}) {
		t.Fatalf("public merge did not apply field overrides and detach: %#v", merged)
	}
}

func TestRuntimeContextCanBeDisabledWithoutDroppingExplicitContext(t *testing.T) {
	explicit, err := NewClient(Config{
		APIKey:                "LOGBREW_API_KEY",
		SDKName:               "logbrew-go",
		SDKVersion:            "0.1.0",
		DisableRuntimeContext: true,
		Context: &TelemetryContext{
			SchemaVersion: 1,
			Tags:          map[string]string{"plan": "team"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := explicit.Log("evt_explicit", "2026-08-03T00:00:00Z", LogAttributes{Message: "safe", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	if got := previewEventContext(t, explicit); !reflect.DeepEqual(got, map[string]any{
		"schemaVersion": float64(1), "tags": map[string]any{"plan": "team"},
	}) {
		t.Fatalf("unexpected explicit-only context: %#v", got)
	}

	absent, err := NewClient(Config{
		APIKey:                "LOGBREW_API_KEY",
		SDKName:               "logbrew-go",
		SDKVersion:            "0.1.0",
		DisableRuntimeContext: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := absent.Log("evt_absent", "2026-08-03T00:00:00Z", LogAttributes{Message: "safe", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	preview, err := absent.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	if _, ok := payload.Events[0].Attributes["context"]; ok {
		t.Fatalf("disabled client unexpectedly captured context: %s", preview)
	}
}

func TestTelemetryContextValidationRejectsUnsafeOrAmbiguousValues(t *testing.T) {
	invalid := []struct {
		name    string
		context *TelemetryContext
		message string
	}{
		{"schema version", &TelemetryContext{SchemaVersion: 2, Tags: map[string]string{"plan": "team"}}, "schemaVersion must be 1"},
		{"empty", &TelemetryContext{SchemaVersion: 1}, "must include resource, trace, session, subject, or tags"},
		{"runtime name", &TelemetryContext{SchemaVersion: 1, Resource: &TelemetryResource{Runtime: &TelemetryNamedVersion{Version: "1.24"}}}, "runtime name is required"},
		{"zero trace", &TelemetryContext{SchemaVersion: 1, Trace: &TelemetryTraceContext{TraceID: strings.Repeat("0", 32)}}, "traceId must be 32 non-zero hex characters"},
		{"same session", &TelemetryContext{SchemaVersion: 1, Session: &TelemetrySessionContext{ID: "same", PreviousID: "same"}}, "previousId must differ from id"},
		{"subject kind", &TelemetryContext{SchemaVersion: 1, Subject: &TelemetrySubjectContext{ID: "user_1", Kind: "person"}}, "kind must be anonymous or user"},
		{"tag key", &TelemetryContext{SchemaVersion: 1, Tags: map[string]string{"bad key": "value"}}, "tags key is invalid"},
		{"control text", &TelemetryContext{SchemaVersion: 1, Tags: map[string]string{"plan": "safe\u0085unsafe"}}, "tags value for plan is invalid"},
	}
	for _, test := range invalid {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewClient(Config{
				APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go", SDKVersion: "0.1.0",
				DisableRuntimeContext: true, Context: test.context,
			})
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}

	baseTags := make(map[string]string, 32)
	for index := 0; index < 32; index++ {
		baseTags[fmt.Sprintf("base.%02d", index)] = "safe"
	}
	client, err := NewClient(Config{
		APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go", SDKVersion: "0.1.0",
		DisableRuntimeContext: true,
		Context:               &TelemetryContext{SchemaVersion: 1, Tags: baseTags},
	})
	if err != nil {
		t.Fatal(err)
	}
	err = client.Log("evt_too_many_tags", "2026-08-03T00:00:00Z", LogAttributes{
		Message: "safe", Level: "info",
		Context: &TelemetryContext{SchemaVersion: 1, Tags: map[string]string{"event.tag": "safe"}},
	})
	if err == nil || !strings.Contains(err.Error(), "merged telemetry context tags must contain 1-32 entries") {
		t.Fatalf("unexpected merged tag error: %v", err)
	}
	if client.PendingEvents() != 0 {
		t.Fatalf("invalid merged context entered queue")
	}
}

func TestTraceHelpersPromoteActiveTraceIntoFirstClassContext(t *testing.T) {
	trace := testTrace(t, "B7AD6B7169203331")
	ctx := ContextWithLogBrewTrace(t.Context(), trace)
	logAttributes := LogAttributesWithTrace(ctx, LogAttributes{
		Message: "checkout failed", Level: "error",
	})
	issueAttributes := IssueAttributesWithTrace(ctx, IssueAttributes{
		Title: "Checkout failed", Level: "error",
		Context: &TelemetryContext{SchemaVersion: 1, Tags: map[string]string{"operation": "checkout"}},
	})
	actionAttributes := ActionAttributesWithTrace(ctx, ActionAttributes{
		Name: "checkout.submitted",
	})
	metricAttributes := MetricAttributesWithTrace(ctx, MetricAttributes{
		Name: "checkout.duration", Kind: "histogram", Value: 42, Unit: "ms", Temporality: "delta",
	})
	spanAttributes, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace: trace, Name: "checkout", Status: "error",
	})
	if err != nil {
		t.Fatal(err)
	}
	for name, context := range map[string]*TelemetryContext{
		"log":    logAttributes.Context,
		"issue":  issueAttributes.Context,
		"action": actionAttributes.Context,
		"metric": metricAttributes.Context,
		"span":   spanAttributes.Context,
	} {
		if context == nil || context.Trace == nil {
			t.Fatalf("%s trace was not promoted into typed context: %#v", name, context)
		}
		if context.Trace.TraceID != trace.TraceID ||
			context.Trace.SpanID != trace.SpanID ||
			context.Trace.ParentSpanID != trace.ParentSpanID ||
			context.Trace.Sampled == nil || !*context.Trace.Sampled {
			t.Fatalf("unexpected %s trace context: %#v", name, context.Trace)
		}
	}
	if issueAttributes.Context.Tags["operation"] != "checkout" {
		t.Fatalf("trace promotion dropped event context: %#v", issueAttributes.Context)
	}

	client, err := NewClient(Config{
		APIKey: "LOGBREW_API_KEY", SDKName: "logbrew-go", SDKVersion: "0.1.0",
		DisableRuntimeContext: true,
		Context: &TelemetryContext{
			SchemaVersion: 1,
			Tags:          map[string]string{"plan": "team"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Issue("evt_traced", "2026-08-03T00:00:00Z", issueAttributes); err != nil {
		t.Fatal(err)
	}
	context := previewEventContext(t, client)
	if !reflect.DeepEqual(context["trace"], map[string]any{
		"traceId":      trace.TraceID,
		"spanId":       trace.SpanID,
		"parentSpanId": trace.ParentSpanID,
		"sampled":      true,
	}) {
		t.Fatalf("queued issue missing exact span correlation: %#v", context)
	}
	if !reflect.DeepEqual(context["tags"], map[string]any{"operation": "checkout", "plan": "team"}) {
		t.Fatalf("queued issue missing merged tags: %#v", context)
	}
}

func previewEventContext(t *testing.T, client *Client) map[string]any {
	t.Helper()
	var payload struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	preview, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	context, ok := payload.Events[0].Attributes["context"].(map[string]any)
	if !ok {
		t.Fatalf("event context missing: %s", preview)
	}
	return context
}
