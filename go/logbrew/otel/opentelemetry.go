// Package logbrewotel adapts existing OpenTelemetry Go traces into LogBrew
// spans without making the root logbrew package own an OTel provider/exporter.
package logbrewotel

import (
	"context"
	"fmt"
	"path"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	oteltrace "go.opentelemetry.io/otel/trace"
)

const (
	defaultEventIDPrefix = "go_otel"
	otelMetadataSource   = "opentelemetry.go"
	maxSpanLinks         = 8
)

var safeAttributeKeys = map[string]string{
	"db.operation":              "dbOperation",
	"db.operation.name":         "dbOperation",
	"db.system":                 "dbSystem",
	"db.system.name":            "dbSystem",
	"code.function.name":        "codeFunction",
	"code.line.number":          "codeLine",
	"code.namespace":            "codeNamespace",
	"error.type":                "errorType",
	"exception.type":            "exceptionType",
	"http.method":               "httpMethod",
	"http.request.method":       "httpMethod",
	"http.response.status_code": "httpStatusCode",
	"http.route":                "httpRoute",
	"http.status_code":          "httpStatusCode",
	"messaging.operation":       "messagingOperation",
	"messaging.operation.name":  "messagingOperation",
	"messaging.system":          "messagingSystem",
	"rpc.method":                "rpcMethod",
	"rpc.service":               "rpcService",
	"rpc.system":                "rpcSystem",
	"server.port":               "serverPort",
	"url.scheme":                "urlScheme",
}

// SpanExporterConfig configures the optional OpenTelemetry span exporter.
type SpanExporterConfig struct {
	// EventIDPrefix prefixes stable LogBrew span event IDs. Empty defaults to
	// go_otel.
	EventIDPrefix string
	// Metadata is merged into every exported span after primitive-only
	// filtering.
	Metadata map[string]any
	// Now supplies event timestamps. Empty defaults to time.Now().UTC.
	Now func() time.Time
}

// SpanExporter implements sdktrace.SpanExporter by queuing sanitized
// OpenTelemetry spans into an app-owned LogBrew client.
type SpanExporter struct {
	client        *logbrew.Client
	eventIDPrefix string
	metadata      map[string]any
	now           func() time.Time

	mu       sync.Mutex
	sequence int
	closed   bool
}

var _ sdktrace.SpanExporter = (*SpanExporter)(nil)

// NewSpanExporter returns an OpenTelemetry span exporter that converts ended
// OTel spans into LogBrew span events. It does not install a global provider,
// create transports, retry, flush, or capture raw propagation, headers, URLs,
// payloads, SQL statements, or exception messages.
func NewSpanExporter(client *logbrew.Client, config SpanExporterConfig) (*SpanExporter, error) {
	if client == nil {
		return nil, &logbrew.SdkError{Code: "configuration_error", Message: "OpenTelemetry span exporter requires a LogBrew client"}
	}
	prefix := strings.TrimSpace(config.EventIDPrefix)
	if prefix == "" {
		prefix = defaultEventIDPrefix
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &SpanExporter{
		client:        client,
		eventIDPrefix: prefix,
		metadata:      compactMetadata(config.Metadata),
		now:           config.Now,
	}, nil
}

// TraceContextFromContext copies the active OpenTelemetry SpanContext from ctx
// into a LogBrew child trace context. It returns ok=false without error when no
// valid OTel span context is active.
func TraceContextFromContext(ctx context.Context, childSpanID string) (logbrew.TraceContext, bool, error) {
	if ctx == nil {
		return logbrew.TraceContext{}, false, nil
	}
	return TraceContextFromSpanContext(oteltrace.SpanContextFromContext(ctx), childSpanID)
}

// TraceContextFromSpanContext copies valid OpenTelemetry trace/span IDs and
// sampled flags into a LogBrew child trace context. Invalid OTel contexts are
// ignored, while invalid explicit child span IDs return a LogBrew validation
// error.
func TraceContextFromSpanContext(spanContext oteltrace.SpanContext, childSpanID string) (logbrew.TraceContext, bool, error) {
	if !spanContext.IsValid() {
		return logbrew.TraceContext{}, false, nil
	}
	traceparent, err := logbrew.CreateTraceparent(
		spanContext.TraceID().String(),
		spanContext.SpanID().String(),
		traceFlags(spanContext),
	)
	if err != nil {
		return logbrew.TraceContext{}, false, err
	}
	trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: traceparent,
		SpanID:      childSpanID,
	})
	if err != nil {
		return logbrew.TraceContext{}, false, err
	}
	return trace, true, nil
}

// ExportSpans converts ended OTel spans into LogBrew span events while honoring
// context cancellation. Retry and network delivery remain the caller's
// app-owned LogBrew Flush/Shutdown responsibility.
func (exporter *SpanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(spans) == 0 {
		return nil
	}
	if exporter == nil || exporter.client == nil {
		return &logbrew.SdkError{Code: "configuration_error", Message: "OpenTelemetry span exporter requires a LogBrew client"}
	}
	for _, span := range spans {
		if err := ctx.Err(); err != nil {
			return err
		}
		if span == nil || !span.SpanContext().IsValid() {
			continue
		}
		eventID, timestamp, err := exporter.nextEvent()
		if err != nil {
			return err
		}
		attributes := exporter.spanAttributes(span)
		if err := exporter.client.Span(eventID, timestamp, attributes); err != nil {
			return err
		}
	}
	return nil
}

// Shutdown marks the exporter as closed. It does not flush the LogBrew client;
// callers should still use client.Flush or client.Shutdown with an app-owned
// transport.
func (exporter *SpanExporter) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if exporter == nil {
		return nil
	}
	exporter.mu.Lock()
	exporter.closed = true
	exporter.mu.Unlock()
	return nil
}

func (exporter *SpanExporter) nextEvent() (string, string, error) {
	exporter.mu.Lock()
	defer exporter.mu.Unlock()
	if exporter.closed {
		return "", "", &logbrew.SdkError{Code: "shutdown_error", Message: "OpenTelemetry span exporter is already shut down"}
	}
	exporter.sequence++
	eventID := fmt.Sprintf("%s_span_%d", exporter.eventIDPrefix, exporter.sequence)
	return eventID, exporter.now().UTC().Format(time.RFC3339Nano), nil
}

func (exporter *SpanExporter) spanAttributes(span sdktrace.ReadOnlySpan) logbrew.SpanAttributes {
	context := span.SpanContext()
	status := "ok"
	if span.Status().Code == codes.Error {
		status = "error"
	}
	metadata := exporter.spanMetadata(span)
	var durationMs *float64
	started := span.StartTime()
	ended := span.EndTime()
	if !started.IsZero() && !ended.IsZero() && !ended.Before(started) {
		duration := float64(ended.Sub(started)) / float64(time.Millisecond)
		durationMs = &duration
	}
	parentSpanID := ""
	if parent := span.Parent(); parent.IsValid() {
		parentSpanID = parent.SpanID().String()
	}
	return logbrew.SpanAttributes{
		Name:         span.Name(),
		TraceID:      context.TraceID().String(),
		SpanID:       context.SpanID().String(),
		ParentSpanID: parentSpanID,
		Status:       status,
		DurationMs:   durationMs,
		Metadata:     metadata,
		Links:        spanLinks(span.Links()),
	}
}

func (exporter *SpanExporter) spanMetadata(span sdktrace.ReadOnlySpan) map[string]any {
	metadata := compactMetadata(exporter.metadata)
	metadata["source"] = otelMetadataSource
	kind := spanKindName(span.SpanKind())
	metadata["spanKind"] = kind
	scope := span.InstrumentationScope()
	if strings.TrimSpace(scope.Name) != "" {
		metadata["instrumentationScopeName"] = scope.Name
	}
	if strings.TrimSpace(scope.Version) != "" {
		metadata["instrumentationScopeVersion"] = scope.Version
	}
	for key, value := range projectedAttributes(span.Attributes()) {
		metadata[key] = value
	}
	metadata["operation"] = semanticOperation(metadata, kind)
	return compactMetadata(metadata)
}

func spanLinks(links []sdktrace.Link) []logbrew.SpanLinkSummary {
	summaries := make([]logbrew.SpanLinkSummary, 0, min(len(links), maxSpanLinks))
	for _, link := range links {
		if len(summaries) >= maxSpanLinks {
			break
		}
		context := link.SpanContext
		if !context.IsValid() {
			continue
		}
		summary, err := logbrew.NewSpanLinkSummary(
			context.TraceID().String(),
			context.SpanID().String(),
			context.IsSampled(),
		)
		if err != nil {
			continue
		}
		summary.Metadata = projectedAttributes(link.Attributes)
		summaries = append(summaries, summary)
	}
	return summaries
}

func projectedAttributes(attributes []attribute.KeyValue) map[string]any {
	metadata := map[string]any{}
	for _, attr := range attributes {
		if attr.Key == "code.file.path" || attr.Key == "code.file.name" {
			if file := safeCodeFile(attr.Value); file != "" {
				metadata["codeFile"] = file
			}
		}
		if key, ok := safeAttributeKeys[string(attr.Key)]; ok {
			if value, include := primitiveAttributeValue(attr.Value); include {
				metadata[key] = value
			}
		}
	}
	return metadata
}

func semanticOperation(metadata map[string]any, kind string) string {
	switch {
	case metadata["httpRoute"] != nil || metadata["httpMethod"] != nil:
		return "http." + kind
	case metadata["dbSystem"] != nil:
		return "db." + kind
	case metadata["messagingSystem"] != nil:
		return "messaging." + kind
	case metadata["rpcSystem"] != nil:
		return "rpc." + kind
	}
	return "otel." + kind
}

func safeCodeFile(value attribute.Value) string {
	if value.Type() != attribute.STRING {
		return ""
	}
	file := path.Base(strings.ReplaceAll(strings.TrimSpace(value.AsString()), "\\", "/"))
	if file == "." || file == "/" || len(file) > 256 || strings.IndexFunc(file, unicode.IsControl) >= 0 {
		return ""
	}
	return file
}

func traceFlags(spanContext oteltrace.SpanContext) string {
	if !spanContext.IsSampled() {
		return "00"
	}
	return "01"
}

func spanKindName(kind oteltrace.SpanKind) string {
	names := [...]string{"unspecified", "internal", "server", "client", "producer", "consumer"}
	index := int(kind)
	if index < 0 || index >= len(names) {
		return "unspecified"
	}
	return names[index]
}

func primitiveAttributeValue(value attribute.Value) (any, bool) {
	switch value.Type() {
	case attribute.BOOL:
		return value.AsBool(), true
	case attribute.INT64:
		return value.AsInt64(), true
	case attribute.FLOAT64:
		return value.AsFloat64(), true
	case attribute.STRING:
		text := strings.TrimSpace(value.AsString())
		return text, text != "" && len(text) <= 256
	default:
		return nil, false
	}
}

func compactMetadata(metadata map[string]any) map[string]any {
	cloned := make(map[string]any)
	for key, value := range metadata {
		if strings.TrimSpace(key) == "" {
			continue
		}
		switch value.(type) {
		case string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			cloned[key] = value
		}
	}
	return cloned
}
