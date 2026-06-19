package logbrew

import (
	"context"
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
