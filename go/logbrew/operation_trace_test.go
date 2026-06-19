package logbrew

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestOperationSpanHelpersCorrelateAndSanitizeMetadata(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	now := func() time.Time {
		return time.Date(2026, 6, 2, 10, 0, 0, 25*int(time.Millisecond), time.UTC)
	}
	var active TraceContext
	result, err := DatabaseOperationWithLogBrewSpan(ctx, client, "select checkout", func(operationCtx context.Context) (string, error) {
		var ok bool
		active, ok = LogBrewTraceFromContext(operationCtx)
		if !ok {
			t.Fatal("expected operation context to carry child trace")
		}
		return "order-123", nil
	}, DatabaseOperationConfig{
		System:            "postgresql",
		OperationKind:     "query",
		DatabaseName:      "orders",
		StatementTemplate: "SELECT * FROM orders WHERE id = ?",
		RowCount:          intPtr(1),
		EventIDPrefix:     "go_db_test",
		Metadata: map[string]any{
			"component": "checkout",
			"query":     "SELECT * FROM orders WHERE id = 'private'",
			"params":    []any{"private"},
			"host":      "db.internal",
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	if err != nil || result != "order-123" {
		t.Fatalf("unexpected result=%q err=%v", result, err)
	}
	if active.TraceID != parent.TraceID || active.ParentSpanID != parent.SpanID || active.SpanID != "b7ad6b7169203331" || !active.Sampled {
		t.Fatalf("unexpected active operation trace: %#v", active)
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
		event.ID != "go_db_test_span_b7ad6b7169203331" ||
		event.Attributes["name"] != "database:select checkout" ||
		event.Attributes["traceId"] != parent.TraceID ||
		event.Attributes["spanId"] != "b7ad6b7169203331" ||
		event.Attributes["parentSpanId"] != parent.SpanID ||
		event.Attributes["status"] != "ok" {
		t.Fatalf("unexpected database span: %#v", event)
	}
	if metadata["source"] != "database.operation" ||
		metadata["dbSystem"] != "postgresql" ||
		metadata["dbOperation"] != "select checkout" ||
		metadata["dbOperationKind"] != "query" ||
		metadata["dbName"] != "orders" ||
		metadata["dbStatementTemplate"] != "SELECT * FROM orders WHERE id = ?" ||
		metadata["rowCount"] != float64(1) ||
		metadata["sampled"] != true ||
		metadata["component"] != "checkout" {
		t.Fatalf("unexpected database metadata: %#v", metadata)
	}
	for _, unsafe := range []string{"private", "db.internal", "params", "host"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("operation span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestCacheAndQueueOperationSpansPreserveErrors(t *testing.T) {
	client := sampleClient(t)
	original := errors.New("broker payload contained private order")
	now := func() time.Time {
		return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	}

	_, err := CacheOperationWithLogBrewSpan(context.Background(), client, "get cart", func(context.Context) (int, error) {
		return 0, original
	}, CacheOperationConfig{
		System:        "redis",
		OperationKind: "get",
		CacheName:     "checkout-cache",
		Hit:           boolPtr(false),
		EventIDPrefix: "go_cache_test",
		Metadata: map[string]any{
			"cacheKey": "cart:private",
			"value":    "sensitive-value",
			"service":  "checkout",
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203332"
		},
		Now: now,
	})
	if !errors.Is(err, original) {
		t.Fatalf("expected original cache error, got %v", err)
	}

	_, err = QueueOperationWithLogBrewSpan(context.Background(), client, "publish invoice", func(context.Context) (string, error) {
		return "not-delivered", original
	}, QueueOperationConfig{
		System:        "kafka",
		OperationKind: "publish",
		QueueName:     "billing-events",
		TaskName:      "invoice.created",
		MessageCount:  intPtr(1),
		EventIDPrefix: "go_queue_test",
		Metadata: map[string]any{
			"messageBody": "private body",
			"brokerURL":   "kafka://private",
			"component":   "billing",
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203333"
		},
		Now: now,
	})
	if !errors.Is(err, original) {
		t.Fatalf("expected original queue error, got %v", err)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"source": "cache.operation"`,
		`"cacheSystem": "redis"`,
		`"cacheHit": false`,
		`"source": "queue.operation"`,
		`"queueSystem": "kafka"`,
		`"queueName": "billing-events"`,
		`"errorType": "*errors.errorString"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{"cart:private", "sensitive-value", "private body", "kafka://private", "broker payload"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("operation span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestOperationSpanCaptureFailureDoesNotReplaceOperationResult(t *testing.T) {
	client := sampleClient(t)
	if _, err := client.Shutdown(AlwaysAcceptTransport()); err != nil {
		t.Fatal(err)
	}
	var reported error
	result, err := DatabaseOperationWithLogBrewSpan(context.Background(), client, "select checkout", func(context.Context) (string, error) {
		return "order-123", nil
	}, DatabaseOperationConfig{
		EventIDPrefix: "go_db_closed",
		SpanIDFactory: func() string {
			return "b7ad6b7169203334"
		},
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
		},
		OnError: func(err error) {
			reported = err
		},
	})
	if err != nil || result != "order-123" {
		t.Fatalf("unexpected result=%q err=%v", result, err)
	}
	if reported == nil || !strings.Contains(reported.Error(), "client is already shut down") {
		t.Fatalf("expected capture failure through OnError, got %v", reported)
	}
}

func intPtr(value int) *int {
	return &value
}

func boolPtr(value bool) *bool {
	return &value
}
