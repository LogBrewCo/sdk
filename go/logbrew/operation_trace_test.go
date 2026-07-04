package logbrew

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

var _ SQLQueryContextRunner = (*sql.DB)(nil)
var _ SQLQueryContextRunner = (*sql.Tx)(nil)
var _ SQLQueryContextRunner = (*sql.Conn)(nil)
var _ SQLStatementQueryContextRunner = (*sql.Stmt)(nil)
var _ SQLExecContextRunner = (*sql.DB)(nil)
var _ SQLExecContextRunner = (*sql.Tx)(nil)
var _ SQLExecContextRunner = (*sql.Conn)(nil)
var _ SQLStatementExecContextRunner = (*sql.Stmt)(nil)
var _ SQLBeginTxRunner = (*sql.DB)(nil)
var _ SQLBeginTxRunner = (*sql.Conn)(nil)

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
			"host":      "opaque-private-target",
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
	for _, unsafe := range []string{"private", "opaque-private-target", "params", "host"} {
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
			"brokerURL":   "opaque-broker-target",
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
	for _, unsafe := range []string{"cart:private", "sensitive-value", "private body", "opaque-broker-target", "broker payload"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("operation span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestOperationSpanHelpersCapturePanicSpanAndRepanicWithoutLeakingValue(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	nowCalls := 0
	now := func() time.Time {
		nowCalls++
		switch nowCalls {
		case 1:
			return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
		default:
			return time.Date(2026, 6, 2, 10, 0, 0, 19*int(time.Millisecond), time.UTC)
		}
	}

	recovered := capturePanic(func() {
		_, _ = DatabaseOperationWithLogBrewSpan(ctx, client, "select checkout", func(operationCtx context.Context) (string, error) {
			if _, ok := LogBrewTraceFromContext(operationCtx); !ok {
				t.Fatal("expected active operation trace before panic")
			}
			panic(errors.New("private database panic value"))
		}, DatabaseOperationConfig{
			System:        "postgresql",
			OperationKind: "query",
			DatabaseName:  "orders",
			EventIDPrefix: "go_db_panic",
			Metadata: map[string]any{
				"component": "checkout",
				"query":     "SELECT private",
			},
			SpanIDFactory: func() string {
				return "b7ad6b7169203331"
			},
			Now: now,
		})
	})
	if recovered == nil || fmt.Sprint(recovered) != "private database panic value" {
		t.Fatalf("expected original panic value, got %#v", recovered)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"id": "go_db_panic_span_b7ad6b7169203331"`) ||
		!strings.Contains(payload, `"status": "error"`) ||
		!strings.Contains(payload, `"durationMs": 19`) ||
		!strings.Contains(payload, `"panic": true`) ||
		!strings.Contains(payload, `"panicType": "*errors.errorString"`) ||
		!strings.Contains(payload, `"component": "checkout"`) ||
		!strings.Contains(payload, `"dbSystem": "postgresql"`) {
		t.Fatalf("missing panic operation span metadata: %s", payload)
	}
	for _, unsafe := range []string{"private database panic value", "SELECT private"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("panic operation span leaked %q: %s", unsafe, payload)
		}
	}
}

func TestQueueOperationWithLogBrewSpanInjectsOutgoingTraceparent(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	headers := map[string]string{
		"traceparent": "caller-value-to-replace",
	}
	var active TraceContext

	result, err := QueueOperationWithLogBrewSpan(ctx, client, "publish checkout", func(operationCtx context.Context) (string, error) {
		var ok bool
		active, ok = LogBrewTraceFromContext(operationCtx)
		if !ok {
			t.Fatal("expected active queue trace")
		}
		return "published", nil
	}, QueueOperationConfig{
		System:        "kafka",
		OperationKind: "publish",
		QueueName:     "checkout-events",
		TaskName:      "checkout.completed",
		EventIDPrefix: "go_queue_publish",
		TraceparentSetter: func(traceparent string) error {
			headers["traceparent"] = traceparent
			headers["traceparent-duplicate"] = "must not be touched by LogBrew"
			return nil
		},
		Metadata: map[string]any{
			"component":   "checkout",
			"headers":     "private headers",
			"messageBody": "private body",
			"traceparent": "raw propagation must not serialize",
		},
		SpanIDFactory: func() string {
			return "b7ad6b7169203345"
		},
		Now: fixedOperationNow(),
	})
	if err != nil || result != "published" {
		t.Fatalf("unexpected result=%q err=%v", result, err)
	}
	if headers["traceparent"] != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203345-01" {
		t.Fatalf("unexpected outgoing traceparent: %q", headers["traceparent"])
	}
	if active.TraceID != parent.TraceID || active.ParentSpanID != parent.SpanID || active.SpanID != "b7ad6b7169203345" || !active.Sampled {
		t.Fatalf("unexpected active queue trace: %#v", active)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"id": "go_queue_publish_span_b7ad6b7169203345"`,
		`"name": "queue:publish checkout"`,
		`"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"`,
		`"spanId": "b7ad6b7169203345"`,
		`"parentSpanId": "a7ad6b7169203330"`,
		`"queueSystem": "kafka"`,
		`"queueOperationKind": "publish"`,
		`"queueName": "checkout-events"`,
		`"taskName": "checkout.completed"`,
		`"component": "checkout"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{"private headers", "private body", "raw propagation", "caller-value-to-replace", "traceparent-duplicate"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("queue propagation leaked %q: %s", unsafe, payload)
		}
	}
}

func TestQueueOperationWithLogBrewSpanContinuesIncomingAndLinksBatchTraceparents(t *testing.T) {
	client := sampleClient(t)
	incoming := "00-11111111111111111111111111111111-2222222222222222-01"
	var active TraceContext
	var reported []error

	result, err := QueueOperationWithLogBrewSpan(context.Background(), client, "process batch", func(operationCtx context.Context) (int, error) {
		var ok bool
		active, ok = LogBrewTraceFromContext(operationCtx)
		if !ok {
			t.Fatal("expected active queue trace")
		}
		return 2, nil
	}, QueueOperationConfig{
		System:              "pubsub",
		OperationKind:       "process",
		QueueName:           "checkout-events",
		MessageCount:        intPtr(3),
		IncomingTraceparent: incoming,
		LinkedTraceparents: []string{
			"00-33333333333333333333333333333333-4444444444444444-01",
			"malformed-traceparent-value",
			"00-55555555555555555555555555555555-6666666666666666-00",
		},
		LinkMetadata: map[string]any{
			"relation":    "batch_item",
			"delivery":    2,
			"payload":     "private batch payload",
			"traceparent": "raw link propagation",
		},
		EventIDPrefix: "go_queue_process",
		SpanIDFactory: func() string {
			return "b7ad6b7169203346"
		},
		Now: fixedOperationNow(),
		OnError: func(err error) {
			reported = append(reported, err)
		},
	})
	if err != nil || result != 2 {
		t.Fatalf("unexpected result=%d err=%v", result, err)
	}
	if active.TraceID != "11111111111111111111111111111111" || active.ParentSpanID != "2222222222222222" || active.SpanID != "b7ad6b7169203346" || !active.Sampled {
		t.Fatalf("unexpected active incoming queue trace: %#v", active)
	}
	if len(reported) != 1 || !strings.Contains(reported[0].Error(), "queue linked traceparent skipped") {
		t.Fatalf("expected one malformed linked traceparent diagnostic, got %#v", reported)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"traceId": "11111111111111111111111111111111"`,
		`"spanId": "b7ad6b7169203346"`,
		`"parentSpanId": "2222222222222222"`,
		`"messageCount": 3`,
		`"links": [`,
		`"traceId": "33333333333333333333333333333333"`,
		`"spanId": "4444444444444444"`,
		`"sampled": true`,
		`"traceId": "55555555555555555555555555555555"`,
		`"spanId": "6666666666666666"`,
		`"sampled": false`,
		`"relation": "batch_item"`,
		`"delivery": 2`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{"malformed-traceparent-value", "private batch payload", "raw link propagation", "traceparent"} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("queue linked propagation leaked %q: %s", unsafe, payload)
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

func TestSQLContextHelpersTraceQueryAndExecWithoutLeakingSQL(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	queryer := &fakeSQLQueryer{}
	execer := &fakeSQLExecer{result: fakeSQLResult{rowsAffected: 3}}

	_, err = SQLQueryContextWithLogBrewSpan(
		ctx,
		client,
		queryer,
		"lookup checkout order",
		"SELECT * FROM orders WHERE account_ref = ?",
		DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "go_sql_query",
			Metadata: map[string]any{
				"component":        "checkout",
				"sql":              "SELECT * FROM orders WHERE account_ref = 'opaque-ref-value'",
				"connectionString": "opaque-private-target",
			},
			SpanIDFactory: func() string {
				return "b7ad6b7169203335"
			},
			Now: fixedOperationNow(),
		},
		"opaque-ref-value",
	)
	if err != nil {
		t.Fatalf("query helper returned error: %v", err)
	}
	if queryer.query != "SELECT * FROM orders WHERE account_ref = ?" ||
		len(queryer.args) != 1 ||
		queryer.args[0] != "opaque-ref-value" {
		t.Fatalf("query helper did not preserve app-owned query call: query=%q args=%#v", queryer.query, queryer.args)
	}
	if queryer.trace.TraceID != parent.TraceID ||
		queryer.trace.ParentSpanID != parent.SpanID ||
		queryer.trace.SpanID != "b7ad6b7169203335" {
		t.Fatalf("query helper did not activate child trace: %#v", queryer.trace)
	}

	result, err := SQLExecContextWithLogBrewSpan(
		ctx,
		client,
		execer,
		"update checkout order",
		"UPDATE orders SET status = ? WHERE id = ?",
		DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "go_sql_exec",
			Metadata: map[string]any{
				"component": "checkout",
				"params":    []any{"private"},
			},
			SpanIDFactory: func() string {
				return "b7ad6b7169203336"
			},
			Now: fixedOperationNow(),
		},
		"paid",
		"order-ref-value",
	)
	if err != nil {
		t.Fatalf("exec helper returned error: %v", err)
	}
	if result == nil {
		t.Fatal("expected exec result")
	}
	if execer.query != "UPDATE orders SET status = ? WHERE id = ?" ||
		len(execer.args) != 2 ||
		execer.args[0] != "paid" ||
		execer.args[1] != "order-ref-value" {
		t.Fatalf("exec helper did not preserve app-owned exec call: query=%q args=%#v", execer.query, execer.args)
	}
	if execer.trace.TraceID != parent.TraceID ||
		execer.trace.ParentSpanID != parent.SpanID ||
		execer.trace.SpanID != "b7ad6b7169203336" {
		t.Fatalf("exec helper did not activate child trace: %#v", execer.trace)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"source": "database.operation"`,
		`"dbSystem": "postgresql"`,
		`"dbOperation": "lookup checkout order"`,
		`"dbOperationKind": "query"`,
		`"dbOperation": "update checkout order"`,
		`"dbOperationKind": "exec"`,
		`"rowCount": 3`,
		`"component": "checkout"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{
		"SELECT * FROM orders",
		"UPDATE orders",
		"opaque-ref-value",
		"opaque-private-target",
		"order-ref-value",
		"params",
		"connectionString",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("SQL helper leaked %q: %s", unsafe, payload)
		}
	}
}

func TestSQLExecRowsAffectedFailureIsDiagnosticOnly(t *testing.T) {
	client := sampleClient(t)
	rowsErr := errors.New("driver exposed private detail")
	execer := &fakeSQLExecer{result: fakeSQLResult{rowsAffectedErr: rowsErr}}
	var reported error

	result, err := SQLExecContextWithLogBrewSpan(
		context.Background(),
		client,
		execer,
		"delete checkout order",
		"DELETE FROM orders WHERE id = ?",
		DatabaseOperationConfig{
			EventIDPrefix: "go_sql_exec_rows",
			SpanIDFactory: func() string {
				return "b7ad6b7169203337"
			},
			Now:     fixedOperationNow(),
			OnError: func(err error) { reported = err },
		},
		"order-ref-value-2",
	)
	if err != nil {
		t.Fatalf("exec helper replaced app result with rows affected error: %v", err)
	}
	if result == nil {
		t.Fatal("expected original exec result")
	}
	if reported == nil || !strings.Contains(reported.Error(), "rows affected") {
		t.Fatalf("expected rows affected diagnostic, got %v", reported)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "rowCount") {
		t.Fatalf("expected rowCount to be omitted after rows affected failure: %s", payload)
	}
	if strings.Contains(payload, "driver exposed private detail") ||
		strings.Contains(payload, "order-ref-value-2") ||
		strings.Contains(payload, "DELETE FROM orders") {
		t.Fatalf("rows affected diagnostic leaked into payload: %s", payload)
	}
}

func TestSQLContextHelpersSupportPreparedStatementRunners(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	queryer := &fakeSQLStmtQueryer{}
	execer := &fakeSQLStmtExecer{result: fakeSQLResult{rowsAffected: 4}}

	_, err = SQLQueryContextWithLogBrewSpan(
		ctx,
		client,
		queryer,
		"prepared lookup checkout order",
		"SELECT * FROM orders WHERE account_ref = ?",
		DatabaseOperationConfig{
			EventIDPrefix: "go_sql_stmt_query",
			SpanIDFactory: func() string {
				return "b7ad6b7169203338"
			},
			Now: fixedOperationNow(),
		},
		"opaque-ref-value",
	)
	if err != nil {
		t.Fatalf("statement query helper returned error: %v", err)
	}
	if queryer.queryTextReceived ||
		len(queryer.args) != 1 ||
		queryer.args[0] != "opaque-ref-value" ||
		queryer.trace.SpanID != "b7ad6b7169203338" {
		t.Fatalf("statement query helper did not use statement-style runner: %#v", queryer)
	}

	result, err := SQLExecContextWithLogBrewSpan(
		ctx,
		client,
		execer,
		"prepared update checkout order",
		"UPDATE orders SET status = ? WHERE id = ?",
		DatabaseOperationConfig{
			EventIDPrefix: "go_sql_stmt_exec",
			SpanIDFactory: func() string {
				return "b7ad6b7169203339"
			},
			Now: fixedOperationNow(),
		},
		"paid",
		"order-ref-value",
	)
	if err != nil {
		t.Fatalf("statement exec helper returned error: %v", err)
	}
	if result == nil ||
		execer.queryTextReceived ||
		len(execer.args) != 2 ||
		execer.args[0] != "paid" ||
		execer.args[1] != "order-ref-value" ||
		execer.trace.SpanID != "b7ad6b7169203339" {
		t.Fatalf("statement exec helper did not use statement-style runner: result=%v execer=%#v", result, execer)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"dbOperation": "prepared lookup checkout order"`,
		`"dbOperationKind": "query"`,
		`"dbOperation": "prepared update checkout order"`,
		`"dbOperationKind": "exec"`,
		`"rowCount": 4`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing statement SQL trace metadata %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{
		"SELECT * FROM orders",
		"UPDATE orders",
		"opaque-ref-value",
		"order-ref-value",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("statement SQL helper leaked %q: %s", unsafe, payload)
		}
	}
}

func TestSQLTransactionWithLogBrewSpanCommitsAndParentsSQLSpans(t *testing.T) {
	client := sampleClient(t)
	parent, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
		SpanID:      "A7AD6B7169203330",
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := ContextWithLogBrewTrace(context.Background(), parent)
	state := &fakeSQLDriverState{}
	db := newFakeSQLDB(t, state)
	defer func() { _ = db.Close() }()

	var transactionTrace TraceContext
	result, err := SQLTransactionWithLogBrewSpan(
		ctx,
		client,
		db,
		"checkout transaction",
		nil,
		func(txCtx context.Context, tx *sql.Tx) (string, error) {
			var ok bool
			transactionTrace, ok = LogBrewTraceFromContext(txCtx)
			if !ok {
				t.Fatal("expected transaction callback context to carry child trace")
			}
			if _, err := SQLExecContextWithLogBrewSpan(
				txCtx,
				client,
				tx,
				"insert checkout order",
				"INSERT INTO orders(account_ref) VALUES (?)",
				DatabaseOperationConfig{
					System:        "postgresql",
					DatabaseName:  "orders",
					EventIDPrefix: "go_sql_tx_exec",
					SpanIDFactory: func() string {
						return "b7ad6b7169203341"
					},
					Now: fixedOperationNow(),
				},
				"opaque-account-ref",
			); err != nil {
				return "", err
			}
			rows, err := SQLQueryContextWithLogBrewSpan(
				txCtx,
				client,
				tx,
				"select checkout order",
				"SELECT * FROM orders WHERE account_ref = ?",
				DatabaseOperationConfig{
					System:        "postgresql",
					DatabaseName:  "orders",
					EventIDPrefix: "go_sql_tx_query",
					SpanIDFactory: func() string {
						return "b7ad6b7169203342"
					},
					Now: fixedOperationNow(),
				},
				"opaque-account-ref",
			)
			if err != nil {
				return "", err
			}
			if err := rows.Close(); err != nil {
				return "", err
			}
			return "committed", nil
		},
		DatabaseOperationConfig{
			System:        "postgresql",
			DatabaseName:  "orders",
			EventIDPrefix: "go_sql_tx",
			Metadata: map[string]any{
				"component":        "checkout",
				"connectionString": "opaque-private-target",
				"sql":              "BEGIN; INSERT INTO orders(account_ref) VALUES ('opaque-account-ref')",
			},
			SpanIDFactory: func() string {
				return "b7ad6b7169203340"
			},
			Now: fixedOperationNow(),
		},
	)
	if err != nil || result != "committed" {
		t.Fatalf("unexpected transaction result=%q err=%v", result, err)
	}
	if state.commits.Load() != 1 || state.rollbacks.Load() != 0 {
		t.Fatalf("unexpected transaction finish: commits=%d rollbacks=%d", state.commits.Load(), state.rollbacks.Load())
	}
	if transactionTrace.TraceID != parent.TraceID ||
		transactionTrace.ParentSpanID != parent.SpanID ||
		transactionTrace.SpanID != "b7ad6b7169203340" {
		t.Fatalf("unexpected transaction trace: %#v", transactionTrace)
	}
	if state.beginTrace.SpanID != transactionTrace.SpanID ||
		state.beginTrace.ParentSpanID != transactionTrace.ParentSpanID {
		t.Fatalf("expected BeginTx to receive transaction trace: begin=%#v tx=%#v", state.beginTrace, transactionTrace)
	}
	if state.execTrace.ParentSpanID != transactionTrace.SpanID ||
		state.queryTrace.ParentSpanID != transactionTrace.SpanID {
		t.Fatalf("expected SQL child spans under transaction span: exec=%#v query=%#v tx=%#v", state.execTrace, state.queryTrace, transactionTrace)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"dbOperation": "checkout transaction"`,
		`"dbOperationKind": "transaction"`,
		`"dbTransactionOutcome": "commit"`,
		`"dbOperation": "insert checkout order"`,
		`"dbOperationKind": "exec"`,
		`"dbOperation": "select checkout order"`,
		`"dbOperationKind": "query"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing transaction SQL trace metadata %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{
		"INSERT INTO orders",
		"SELECT * FROM orders",
		"opaque-account-ref",
		"opaque-private-target",
		"connectionString",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("transaction SQL helper leaked %q: %s", unsafe, payload)
		}
	}
}

func TestSQLTransactionWithLogBrewSpanRollsBackAndKeepsRollbackDiagnosticRedacted(t *testing.T) {
	client := sampleClient(t)
	state := &fakeSQLDriverState{rollbackErr: errors.New("driver rollback exposed private detail")}
	db := newFakeSQLDB(t, state)
	defer func() { _ = db.Close() }()
	operationErr := errors.New("application failure with private detail")
	var reported error

	_, err := SQLTransactionWithLogBrewSpan(
		context.Background(),
		client,
		db,
		"checkout transaction",
		nil,
		func(context.Context, *sql.Tx) (string, error) {
			return "not-committed", operationErr
		},
		DatabaseOperationConfig{
			System:        "postgresql",
			EventIDPrefix: "go_sql_tx_rollback",
			SpanIDFactory: func() string {
				return "b7ad6b7169203343"
			},
			Now:     fixedOperationNow(),
			OnError: func(err error) { reported = err },
		},
	)
	if !errors.Is(err, operationErr) {
		t.Fatalf("expected original operation error, got %v", err)
	}
	if state.commits.Load() != 0 || state.rollbacks.Load() != 1 {
		t.Fatalf("unexpected transaction finish after error: commits=%d rollbacks=%d", state.commits.Load(), state.rollbacks.Load())
	}
	if reported == nil || !strings.Contains(reported.Error(), "transaction rollback failed") {
		t.Fatalf("expected redacted rollback diagnostic, got %v", reported)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		`"dbOperation": "checkout transaction"`,
		`"dbOperationKind": "transaction"`,
		`"dbTransactionOutcome": "rollback_error"`,
		`"status": "error"`,
		`"errorType": "*errors.errorString"`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing rollback transaction metadata %s in payload: %s", want, payload)
		}
	}
	for _, unsafe := range []string{
		"application failure with private detail",
		"driver rollback exposed private detail",
	} {
		if strings.Contains(payload, unsafe) {
			t.Fatalf("transaction rollback path leaked %q: %s", unsafe, payload)
		}
	}
}

func TestSQLTransactionWithLogBrewSpanRollsBackAndRepanics(t *testing.T) {
	client := sampleClient(t)
	state := &fakeSQLDriverState{}
	db := newFakeSQLDB(t, state)
	defer func() { _ = db.Close() }()
	defer func() {
		recovered := recover()
		if recovered != "panic from app transaction" {
			t.Fatalf("expected original panic to propagate, got %#v", recovered)
		}
		if state.commits.Load() != 0 || state.rollbacks.Load() != 1 {
			t.Fatalf("expected rollback before repanic: commits=%d rollbacks=%d", state.commits.Load(), state.rollbacks.Load())
		}
		payload, err := client.PreviewJSON()
		if err != nil {
			t.Fatalf("preview json: %v", err)
		}
		for _, want := range []string{
			`"id": "go_sql_tx_panic_span_b7ad6b7169203344"`,
			`"status": "error"`,
			`"panic": true`,
			`"panicType": "string"`,
			`"dbTransactionOutcome": "panic_rollback"`,
		} {
			if !strings.Contains(payload, want) {
				t.Fatalf("missing transaction panic span metadata %s: %s", want, payload)
			}
		}
		if strings.Contains(payload, "panic from app transaction") {
			t.Fatalf("transaction panic span leaked panic value: %s", payload)
		}
	}()

	_, _ = SQLTransactionWithLogBrewSpan(
		context.Background(),
		client,
		db,
		"checkout transaction",
		nil,
		func(context.Context, *sql.Tx) (string, error) {
			panic("panic from app transaction")
		},
		DatabaseOperationConfig{
			EventIDPrefix: "go_sql_tx_panic",
			SpanIDFactory: func() string {
				return "b7ad6b7169203344"
			},
			Now: fixedOperationNow(),
		},
	)
	t.Fatal("expected transaction helper to repanic")
}

func fixedOperationNow() func() time.Time {
	return func() time.Time {
		return time.Date(2026, 6, 2, 10, 0, 0, 25*int(time.Millisecond), time.UTC)
	}
}

type fakeSQLQueryer struct {
	query string
	args  []any
	trace TraceContext
}

func (q *fakeSQLQueryer) QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error) {
	q.query = query
	q.args = append([]any{}, args...)
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	q.trace = trace
	return nil, nil
}

type fakeSQLExecer struct {
	query  string
	args   []any
	trace  TraceContext
	result sql.Result
	err    error
}

func (e *fakeSQLExecer) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	e.query = query
	e.args = append([]any{}, args...)
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	e.trace = trace
	return e.result, e.err
}

type fakeSQLStmtQueryer struct {
	queryTextReceived bool
	args              []any
	trace             TraceContext
}

func (q *fakeSQLStmtQueryer) QueryContext(ctx context.Context, args ...any) (*sql.Rows, error) {
	q.args = append([]any{}, args...)
	if len(args) > 0 {
		if value, ok := args[0].(string); ok && strings.Contains(value, "SELECT * FROM orders") {
			q.queryTextReceived = true
		}
	}
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	q.trace = trace
	return nil, nil
}

type fakeSQLStmtExecer struct {
	queryTextReceived bool
	args              []any
	trace             TraceContext
	result            sql.Result
}

func (e *fakeSQLStmtExecer) ExecContext(ctx context.Context, args ...any) (sql.Result, error) {
	e.args = append([]any{}, args...)
	if len(args) > 0 {
		if value, ok := args[0].(string); ok && strings.Contains(value, "UPDATE orders") {
			e.queryTextReceived = true
		}
	}
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	e.trace = trace
	return e.result, nil
}

type fakeSQLResult struct {
	lastInsertID    int64
	lastInsertIDErr error
	rowsAffected    int64
	rowsAffectedErr error
}

func (r fakeSQLResult) LastInsertId() (int64, error) {
	return r.lastInsertID, r.lastInsertIDErr
}

func (r fakeSQLResult) RowsAffected() (int64, error) {
	return r.rowsAffected, r.rowsAffectedErr
}

func intPtr(value int) *int {
	return &value
}

func boolPtr(value bool) *bool {
	return &value
}

var fakeSQLDriverCounter atomic.Uint64

type fakeSQLDriverState struct {
	commits     atomic.Int64
	rollbacks   atomic.Int64
	rollbackErr error
	beginTrace  TraceContext
	execTrace   TraceContext
	queryTrace  TraceContext
}

func newFakeSQLDB(t *testing.T, state *fakeSQLDriverState) *sql.DB {
	t.Helper()
	driverName := fmt.Sprintf("logbrew_fake_sql_%d", fakeSQLDriverCounter.Add(1))
	sql.Register(driverName, &fakeSQLDriver{state: state})
	db, err := sql.Open(driverName, "")
	if err != nil {
		t.Fatalf("open fake SQL DB: %v", err)
	}
	return db
}

type fakeSQLDriver struct {
	state *fakeSQLDriverState
}

func (d *fakeSQLDriver) Open(string) (driver.Conn, error) {
	return &fakeSQLDriverConn{state: d.state}, nil
}

type fakeSQLDriverConn struct {
	state *fakeSQLDriverState
}

func (c *fakeSQLDriverConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepare is not used by the fake SQL driver")
}

func (c *fakeSQLDriverConn) Close() error {
	return nil
}

func (c *fakeSQLDriverConn) Begin() (driver.Tx, error) {
	return c.BeginTx(context.Background(), driver.TxOptions{})
}

func (c *fakeSQLDriverConn) BeginTx(ctx context.Context, _ driver.TxOptions) (driver.Tx, error) {
	if trace, ok := LogBrewTraceFromContext(ctx); ok {
		c.state.beginTrace = trace
	}
	return &fakeSQLDriverTx{state: c.state}, nil
}

func (c *fakeSQLDriverConn) ExecContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Result, error) {
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	c.state.execTrace = trace
	return fakeSQLDriverResult(1), nil
}

func (c *fakeSQLDriverConn) QueryContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil, errors.New("missing LogBrew trace")
	}
	c.state.queryTrace = trace
	return fakeSQLDriverRows{}, nil
}

type fakeSQLDriverTx struct {
	state *fakeSQLDriverState
}

func (tx *fakeSQLDriverTx) Commit() error {
	tx.state.commits.Add(1)
	return nil
}

func (tx *fakeSQLDriverTx) Rollback() error {
	tx.state.rollbacks.Add(1)
	return tx.state.rollbackErr
}

type fakeSQLDriverResult int64

func (r fakeSQLDriverResult) LastInsertId() (int64, error) {
	return 0, nil
}

func (r fakeSQLDriverResult) RowsAffected() (int64, error) {
	return int64(r), nil
}

type fakeSQLDriverRows struct{}

func (fakeSQLDriverRows) Columns() []string {
	return []string{"ok"}
}

func (fakeSQLDriverRows) Close() error {
	return nil
}

func (fakeSQLDriverRows) Next([]driver.Value) error {
	return io.EOF
}
