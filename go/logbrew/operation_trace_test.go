package logbrew

import (
	"context"
	"database/sql"
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
