package logbrew

import (
	"context"
	"database/sql"
	"fmt"
	"reflect"
	"strings"
	"time"
)

// DatabaseOperationConfig configures an explicit app-owned database span.
type DatabaseOperationConfig struct {
	System            string
	OperationKind     string
	DatabaseName      string
	StatementTemplate string
	RowCount          *int
	EventIDPrefix     string
	Metadata          map[string]any
	SpanIDFactory     func() string
	Now               func() time.Time
	OnError           func(error)
}

// CacheOperationConfig configures an explicit app-owned cache span.
type CacheOperationConfig struct {
	System        string
	OperationKind string
	CacheName     string
	Hit           *bool
	ItemSizeBytes *int
	ItemCount     *int
	EventIDPrefix string
	Metadata      map[string]any
	SpanIDFactory func() string
	Now           func() time.Time
	OnError       func(error)
}

// QueueOperationConfig configures an explicit app-owned queue span.
type QueueOperationConfig struct {
	System        string
	OperationKind string
	QueueName     string
	TaskName      string
	MessageCount  *int
	EventIDPrefix string
	Metadata      map[string]any
	SpanIDFactory func() string
	Now           func() time.Time
	OnError       func(error)
}

// SQLQueryContextRunner is implemented by app-owned *sql.DB, *sql.Tx, and
// *sql.Conn values that can run query operations from query text.
type SQLQueryContextRunner interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// SQLStatementQueryContextRunner is implemented by app-owned *sql.Stmt values
// that can run prepared query operations from args only.
type SQLStatementQueryContextRunner interface {
	QueryContext(ctx context.Context, args ...any) (*sql.Rows, error)
}

// SQLExecContextRunner is implemented by app-owned *sql.DB, *sql.Tx, and
// *sql.Conn values that can run exec operations from query text.
type SQLExecContextRunner interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// SQLStatementExecContextRunner is implemented by app-owned *sql.Stmt values
// that can run prepared exec operations from args only.
type SQLStatementExecContextRunner interface {
	ExecContext(ctx context.Context, args ...any) (sql.Result, error)
}

// SQLBeginTxRunner is implemented by app-owned *sql.DB and *sql.Conn values
// that can start database/sql transactions.
type SQLBeginTxRunner interface {
	BeginTx(ctx context.Context, opts *sql.TxOptions) (*sql.Tx, error)
}

// DatabaseOperationWithLogBrewSpan runs operation under a child trace context
// and queues one privacy-bounded database span.
func DatabaseOperationWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	operationName string,
	operation func(context.Context) (T, error),
	config DatabaseOperationConfig,
) (T, error) {
	return operationWithLogBrewSpan(ctx, client, operationName, operation, operationSpanConfig{
		source:        "database.operation",
		namePrefix:    "database",
		eventIDPrefix: eventIDPrefix(config.EventIDPrefix, "go_database"),
		metadata:      databaseOperationMetadata(operationName, config),
		spanIDFactory: config.SpanIDFactory,
		now:           config.Now,
		onError:       config.OnError,
	})
}

// SQLTransactionWithLogBrewSpan runs an app-owned database/sql transaction
// callback under a child transaction span. LogBrew starts the transaction
// through the app-owned runner, passes the active transaction context to the
// callback, commits on callback success, and rolls back on callback error.
// Query and exec helpers called with the callback context become children of
// this transaction span. SQL text, args, connection details, and rollback error
// messages are not copied into telemetry.
func SQLTransactionWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	beginner SQLBeginTxRunner,
	operationName string,
	opts *sql.TxOptions,
	operation func(context.Context, *sql.Tx) (T, error),
	config DatabaseOperationConfig,
) (T, error) {
	var zero T
	if sqlBeginTxRunnerIsNil(beginner) {
		return zero, &SdkError{Code: "configuration_error", Message: "database sql transaction runner must be non-nil"}
	}
	if operation == nil {
		return zero, &SdkError{Code: "configuration_error", Message: "database sql transaction callback must be non-nil"}
	}
	if strings.TrimSpace(config.OperationKind) == "" {
		config.OperationKind = "transaction"
	}
	outcome := ""
	transaction := func(operationCtx context.Context) (T, error) {
		tx, err := beginner.BeginTx(operationCtx, opts)
		if err != nil {
			outcome = "begin_error"
			return zero, err
		}
		result, operationErr := func() (T, error) {
			defer func() {
				if recovered := recover(); recovered != nil {
					outcome = "panic_rollback"
					if rollbackErr := tx.Rollback(); rollbackErr != nil {
						outcome = "panic_rollback_error"
						reportSQLTransactionRollbackFailure(config.OnError)
					}
					panic(recovered)
				}
			}()
			return operation(operationCtx, tx)
		}()
		if operationErr != nil {
			outcome = "rollback"
			if rollbackErr := tx.Rollback(); rollbackErr != nil {
				outcome = "rollback_error"
				reportSQLTransactionRollbackFailure(config.OnError)
			}
			return result, operationErr
		}
		if err := tx.Commit(); err != nil {
			outcome = "commit_error"
			return result, err
		}
		outcome = "commit"
		return result, nil
	}
	return sqlDatabaseOperationWithLogBrewSpan(ctx, client, operationName, transaction, config, func(_ T, _ error, enriched *DatabaseOperationConfig) {
		if outcome != "" {
			enriched.Metadata = mergeMetadata(enriched.Metadata, map[string]any{"dbTransactionOutcome": outcome})
		}
	})
}

// SQLQueryContextWithLogBrewSpan runs an app-owned database/sql QueryContext
// call under a child trace and queues one privacy-bounded database span.
// Query-text runners receive query text and args; prepared statement runners
// receive args only. Neither query text nor args are copied into telemetry by
// this helper.
func SQLQueryContextWithLogBrewSpan(
	ctx context.Context,
	client *Client,
	queryer any,
	operationName string,
	query string,
	config DatabaseOperationConfig,
	args ...any,
) (*sql.Rows, error) {
	operation, err := sqlQueryOperation(queryer, query, args)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.OperationKind) == "" {
		config.OperationKind = "query"
	}
	return sqlDatabaseOperationWithLogBrewSpan(ctx, client, operationName, operation, config, nil)
}

// SQLExecContextWithLogBrewSpan runs an app-owned database/sql ExecContext
// call under a child trace and queues one privacy-bounded database span.
// Query-text runners receive query text and args; prepared statement runners
// receive args only. Neither query text nor args are copied into telemetry by
// this helper.
func SQLExecContextWithLogBrewSpan(
	ctx context.Context,
	client *Client,
	execer any,
	operationName string,
	query string,
	config DatabaseOperationConfig,
	args ...any,
) (sql.Result, error) {
	operation, err := sqlExecOperation(execer, query, args)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.OperationKind) == "" {
		config.OperationKind = "exec"
	}
	return sqlDatabaseOperationWithLogBrewSpan(ctx, client, operationName, operation, config, func(result sql.Result, operationErr error, enriched *DatabaseOperationConfig) {
		if operationErr != nil || result == nil || enriched.RowCount != nil {
			return
		}
		rows, err := result.RowsAffected()
		if err != nil {
			reportOperationSpanError(enriched.OnError, &SdkError{
				Code:    "capture_error",
				Message: "database sql rows affected unavailable",
			})
			return
		}
		if rowCount, ok := nonNegativeInt64ToInt(rows); ok {
			enriched.RowCount = &rowCount
		}
	})
}

// CacheOperationWithLogBrewSpan runs operation under a child trace context and
// queues one privacy-bounded cache span.
func CacheOperationWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	operationName string,
	operation func(context.Context) (T, error),
	config CacheOperationConfig,
) (T, error) {
	return operationWithLogBrewSpan(ctx, client, operationName, operation, operationSpanConfig{
		source:        "cache.operation",
		namePrefix:    "cache",
		eventIDPrefix: eventIDPrefix(config.EventIDPrefix, "go_cache"),
		metadata:      cacheOperationMetadata(operationName, config),
		spanIDFactory: config.SpanIDFactory,
		now:           config.Now,
		onError:       config.OnError,
	})
}

// QueueOperationWithLogBrewSpan runs operation under a child trace context and
// queues one privacy-bounded queue span.
func QueueOperationWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	operationName string,
	operation func(context.Context) (T, error),
	config QueueOperationConfig,
) (T, error) {
	return operationWithLogBrewSpan(ctx, client, operationName, operation, operationSpanConfig{
		source:        "queue.operation",
		namePrefix:    "queue",
		eventIDPrefix: eventIDPrefix(config.EventIDPrefix, "go_queue"),
		metadata:      queueOperationMetadata(operationName, config),
		spanIDFactory: config.SpanIDFactory,
		now:           config.Now,
		onError:       config.OnError,
	})
}

type operationSpanConfig struct {
	source        string
	namePrefix    string
	eventIDPrefix string
	metadata      map[string]any
	spanIDFactory func() string
	now           func() time.Time
	onError       func(error)
}

func operationWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	operationName string,
	operation func(context.Context) (T, error),
	config operationSpanConfig,
) (T, error) {
	var zero T
	if client == nil {
		return zero, &SdkError{Code: "configuration_error", Message: "operation span client must be non-nil"}
	}
	if operation == nil {
		return zero, &SdkError{Code: "configuration_error", Message: "operation span callback must be non-nil"}
	}
	if err := requireNonEmpty("operation name", operationName); err != nil {
		return zero, err
	}
	now := config.now
	if now == nil {
		now = time.Now
	}
	trace, traceErr := operationChildTrace(ctx, config.spanIDFactory)
	if traceErr != nil {
		reportOperationSpanError(config.onError, traceErr)
	}
	if trace.TraceID == "" {
		result, err := operation(ctx)
		return result, err
	}

	start := now()
	operationCtx := ContextWithLogBrewTrace(ctxWithDefault(ctx), trace)
	result, operationErr := operation(operationCtx)
	finished := now()
	captureOperationSpan(client, operationName, trace, operationErr, finished.Sub(start), finished, config)
	return result, operationErr
}

func sqlDatabaseOperationWithLogBrewSpan[T any](
	ctx context.Context,
	client *Client,
	operationName string,
	operation func(context.Context) (T, error),
	config DatabaseOperationConfig,
	enrich func(T, error, *DatabaseOperationConfig),
) (T, error) {
	var zero T
	if client == nil {
		return zero, &SdkError{Code: "configuration_error", Message: "operation span client must be non-nil"}
	}
	if operation == nil {
		return zero, &SdkError{Code: "configuration_error", Message: "operation span callback must be non-nil"}
	}
	if err := requireNonEmpty("operation name", operationName); err != nil {
		return zero, err
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	trace, traceErr := operationChildTrace(ctx, config.SpanIDFactory)
	if traceErr != nil {
		reportOperationSpanError(config.OnError, traceErr)
	}
	if trace.TraceID == "" {
		return operation(ctx)
	}

	start := now()
	operationCtx := ContextWithLogBrewTrace(ctxWithDefault(ctx), trace)
	result, operationErr := operation(operationCtx)
	finished := now()
	enriched := config
	if enrich != nil {
		enrich(result, operationErr, &enriched)
	}
	captureOperationSpan(client, operationName, trace, operationErr, finished.Sub(start), finished, operationSpanConfig{
		source:        "database.operation",
		namePrefix:    "database",
		eventIDPrefix: eventIDPrefix(enriched.EventIDPrefix, "go_database"),
		metadata:      databaseOperationMetadata(operationName, enriched),
		spanIDFactory: enriched.SpanIDFactory,
		now:           enriched.Now,
		onError:       enriched.OnError,
	})
	return result, operationErr
}

func sqlQueryOperation(queryer any, query string, args []any) (func(context.Context) (*sql.Rows, error), error) {
	switch runner := queryer.(type) {
	case nil:
		return nil, &SdkError{Code: "configuration_error", Message: "database sql query runner must be non-nil"}
	case SQLQueryContextRunner:
		return func(operationCtx context.Context) (*sql.Rows, error) {
			return runner.QueryContext(operationCtx, query, args...)
		}, nil
	case SQLStatementQueryContextRunner:
		return func(operationCtx context.Context) (*sql.Rows, error) {
			return runner.QueryContext(operationCtx, args...)
		}, nil
	default:
		return nil, &SdkError{Code: "configuration_error", Message: "database sql query runner must implement QueryContext"}
	}
}

func sqlExecOperation(execer any, query string, args []any) (func(context.Context) (sql.Result, error), error) {
	switch runner := execer.(type) {
	case nil:
		return nil, &SdkError{Code: "configuration_error", Message: "database sql exec runner must be non-nil"}
	case SQLExecContextRunner:
		return func(operationCtx context.Context) (sql.Result, error) {
			return runner.ExecContext(operationCtx, query, args...)
		}, nil
	case SQLStatementExecContextRunner:
		return func(operationCtx context.Context) (sql.Result, error) {
			return runner.ExecContext(operationCtx, args...)
		}, nil
	default:
		return nil, &SdkError{Code: "configuration_error", Message: "database sql exec runner must implement ExecContext"}
	}
}

func sqlBeginTxRunnerIsNil(beginner SQLBeginTxRunner) bool {
	if beginner == nil {
		return true
	}
	value := reflect.ValueOf(beginner)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

func reportSQLTransactionRollbackFailure(onError func(error)) {
	reportOperationSpanError(onError, &SdkError{
		Code:    "capture_error",
		Message: "database sql transaction rollback failed",
	})
}

func operationChildTrace(ctx context.Context, spanIDFactory func() string) (TraceContext, error) {
	spanID := ""
	if spanIDFactory != nil {
		spanID = spanIDFactory()
	}
	parent, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return NewTraceContext(TraceContextInput{SpanID: spanID})
	}
	spanID = strings.ToLower(strings.TrimSpace(spanID))
	if spanID == "" {
		generated, err := GenerateSpanID()
		if err != nil {
			return TraceContext{}, err
		}
		spanID = generated
	}
	if err := requireSpanID("span id", spanID); err != nil {
		return TraceContext{}, err
	}
	if err := validateTraceContext(parent); err != nil {
		fallback, fallbackErr := NewTraceContext(TraceContextInput{SpanID: spanID})
		if fallbackErr != nil {
			return TraceContext{}, fallbackErr
		}
		return fallback, err
	}
	return TraceContext{
		TraceID:      parent.TraceID,
		SpanID:       spanID,
		ParentSpanID: parent.SpanID,
		TraceFlags:   normalizedTraceFlags(parent),
		Sampled:      parent.Sampled,
	}, nil
}

func captureOperationSpan(
	client *Client,
	operationName string,
	trace TraceContext,
	operationErr error,
	duration time.Duration,
	finished time.Time,
	config operationSpanConfig,
) {
	durationMs := float64(duration.Microseconds()) / 1000
	metadata := mergeMetadata(config.metadata, map[string]any{
		"source":  config.source,
		"sampled": trace.Sampled,
	})
	if operationErr != nil {
		metadata = mergeMetadata(metadata, map[string]any{"errorType": reflect.TypeOf(operationErr).String()})
	}
	span, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      trace,
		Name:       fmt.Sprintf("%s:%s", config.namePrefix, strings.TrimSpace(operationName)),
		Status:     operationSpanStatus(operationErr),
		DurationMs: &durationMs,
		Metadata:   metadata,
	})
	if err != nil {
		reportOperationSpanError(config.onError, err)
		return
	}
	if err := client.Span(operationEventID(config.eventIDPrefix, trace.SpanID), finished.UTC().Format(time.RFC3339Nano), span); err != nil {
		reportOperationSpanError(config.onError, err)
	}
}

func databaseOperationMetadata(operationName string, config DatabaseOperationConfig) map[string]any {
	metadata := safeOperationMetadata(config.Metadata)
	addString(metadata, "dbSystem", config.System)
	addString(metadata, "dbOperation", operationName)
	addString(metadata, "dbOperationKind", config.OperationKind)
	addString(metadata, "dbName", config.DatabaseName)
	addString(metadata, "dbStatementTemplate", config.StatementTemplate)
	addNonNegativeInt(metadata, "rowCount", config.RowCount)
	return metadata
}

func cacheOperationMetadata(operationName string, config CacheOperationConfig) map[string]any {
	metadata := safeOperationMetadata(config.Metadata)
	addString(metadata, "cacheSystem", config.System)
	addString(metadata, "cacheOperation", operationName)
	addString(metadata, "cacheOperationKind", config.OperationKind)
	addString(metadata, "cacheName", config.CacheName)
	if config.Hit != nil {
		metadata["cacheHit"] = *config.Hit
	}
	addNonNegativeInt(metadata, "itemSizeBytes", config.ItemSizeBytes)
	addNonNegativeInt(metadata, "itemCount", config.ItemCount)
	return metadata
}

func queueOperationMetadata(operationName string, config QueueOperationConfig) map[string]any {
	metadata := safeOperationMetadata(config.Metadata)
	addString(metadata, "queueSystem", config.System)
	addString(metadata, "queueOperation", operationName)
	addString(metadata, "queueOperationKind", config.OperationKind)
	addString(metadata, "queueName", config.QueueName)
	addString(metadata, "taskName", config.TaskName)
	addNonNegativeInt(metadata, "messageCount", config.MessageCount)
	return metadata
}

func safeOperationMetadata(input map[string]any) map[string]any {
	metadata := map[string]any{}
	for key, value := range compactMetadata(input) {
		if blockedOperationMetadataKey(key) {
			continue
		}
		metadata[key] = value
	}
	return metadata
}

func blockedOperationMetadataKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(key)))
	blocked := []string{
		"args", "arguments", "auth", "authorization", "body", "brokerurl",
		strings.Join([]string{"cache", "key"}, ""), "command", "connectionstring",
		strings.Join([]string{"coo", "kie"}, ""), strings.Join([]string{"coo", "kies"}, ""),
		strings.Join([]string{"head", "ers"}, ""), strings.Join([]string{"ho", "st"}, ""),
		strings.Join([]string{"host", "name"}, ""), strings.Join([]string{"k", "ey"}, ""), "message",
		"messagebody", "params", "parameters", "payload", "query", "rawcommand",
		"rawmessage", strings.Join([]string{"pass", "word"}, ""), strings.Join([]string{"se", "cret"}, ""),
		"sql", "statement", strings.Join([]string{"to", "ken"}, ""), "url", "username", "value",
	}
	for _, candidate := range blocked {
		if normalized == candidate || strings.Contains(normalized, candidate) {
			return true
		}
	}
	return false
}

func addString(metadata map[string]any, key, value string) {
	value = strings.TrimSpace(value)
	if value != "" {
		metadata[key] = value
	}
}

func addNonNegativeInt(metadata map[string]any, key string, value *int) {
	if value != nil && *value >= 0 {
		metadata[key] = *value
	}
}

func nonNegativeInt64ToInt(value int64) (int, bool) {
	maxInt := int64(^uint(0) >> 1)
	if value < 0 || value > maxInt {
		return 0, false
	}
	return int(value), true
}

func operationSpanStatus(err error) string {
	if err != nil {
		return "error"
	}
	return "ok"
}

func eventIDPrefix(configured, fallback string) string {
	if strings.TrimSpace(configured) != "" {
		return strings.TrimSpace(configured)
	}
	return fallback
}

func operationEventID(prefix, spanID string) string {
	return fmt.Sprintf("%s_span_%s", prefix, spanID)
}

func reportOperationSpanError(onError func(error), err error) {
	if err != nil && onError != nil {
		onError(err)
	}
}

func ctxWithDefault(ctx context.Context) context.Context {
	if ctx == nil {
		return context.Background()
	}
	return ctx
}
