package logbrew

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"strings"
)

type logbrewTraceContextKey struct{}

// TraceContext is the request-local LogBrew trace state safe to attach to logs,
// spans, issues, and callbacks.
type TraceContext struct {
	TraceID      string
	SpanID       string
	ParentSpanID string
	TraceFlags   string
	Sampled      bool
}

// TraceContextInput creates request-local trace context from an optional W3C
// traceparent header and optional explicit child span ID.
type TraceContextInput struct {
	Traceparent string
	SpanID      string
}

// TraceContextSpanInput describes a LogBrew span derived from a request-local
// TraceContext.
type TraceContextSpanInput struct {
	Trace      TraceContext
	Name       string
	Status     string
	DurationMs *float64
	Metadata   map[string]any
	Links      []SpanLinkSummary
}

// NewTraceContext creates a request-local trace context. When Traceparent is
// empty it starts a fresh W3C-shaped local trace; malformed traceparent values
// are returned as validation errors so framework helpers can choose whether to
// fall back non-fatally.
func NewTraceContext(input TraceContextInput) (TraceContext, error) {
	spanID := strings.ToLower(strings.TrimSpace(input.SpanID))
	if spanID == "" {
		generatedSpanID, err := GenerateSpanID()
		if err != nil {
			return TraceContext{}, err
		}
		spanID = generatedSpanID
	}
	if err := requireSpanID("span id", spanID); err != nil {
		return TraceContext{}, err
	}

	traceparent := strings.TrimSpace(input.Traceparent)
	if traceparent == "" {
		traceID, err := GenerateTraceID()
		if err != nil {
			return TraceContext{}, err
		}
		return TraceContext{
			TraceID:    traceID,
			SpanID:     spanID,
			TraceFlags: "00",
			Sampled:    false,
		}, nil
	}

	parsed, err := ParseTraceparent(traceparent)
	if err != nil {
		return TraceContext{}, err
	}
	return TraceContext{
		TraceID:      parsed.TraceID,
		SpanID:       spanID,
		ParentSpanID: parsed.ParentSpanID,
		TraceFlags:   parsed.TraceFlags,
		Sampled:      parsed.Sampled,
	}, nil
}

// GenerateTraceID returns a fresh non-zero W3C-compatible trace ID.
func GenerateTraceID() (string, error) {
	return randomHexID(16, zeroTraceID)
}

// GenerateSpanID returns a fresh non-zero W3C-compatible span ID.
func GenerateSpanID() (string, error) {
	return randomHexID(8, zeroSpanID)
}

// ContextWithLogBrewTrace attaches trace context to a Go context.
func ContextWithLogBrewTrace(parent context.Context, trace TraceContext) context.Context {
	return context.WithValue(parent, logbrewTraceContextKey{}, trace)
}

// LogBrewTraceFromContext returns the active LogBrew trace context, when one is
// attached to ctx.
func LogBrewTraceFromContext(ctx context.Context) (TraceContext, bool) {
	if ctx == nil {
		return TraceContext{}, false
	}
	trace, ok := ctx.Value(logbrewTraceContextKey{}).(TraceContext)
	return trace, ok
}

// Metadata returns primitive-only trace metadata for logs, issues, and metrics.
func (trace TraceContext) Metadata() map[string]any {
	metadata := map[string]any{
		"traceId": trace.TraceID,
		"spanId":  trace.SpanID,
		"sampled": trace.Sampled,
	}
	if trace.ParentSpanID != "" {
		metadata["parentSpanId"] = trace.ParentSpanID
	}
	return metadata
}

// TraceMetadataFromContext returns primitive trace metadata from ctx, when a
// LogBrew trace context is active.
func TraceMetadataFromContext(ctx context.Context) map[string]any {
	trace, ok := LogBrewTraceFromContext(ctx)
	if !ok {
		return nil
	}
	return trace.Metadata()
}

// LogAttributesWithTrace merges active trace metadata into log attributes.
func LogAttributesWithTrace(ctx context.Context, attributes LogAttributes) LogAttributes {
	if metadata := TraceMetadataFromContext(ctx); metadata != nil {
		attributes.Metadata = mergeMetadata(attributes.Metadata, metadata)
	}
	return attributes
}

// IssueAttributesWithTrace merges active trace metadata into issue attributes.
func IssueAttributesWithTrace(ctx context.Context, attributes IssueAttributes) IssueAttributes {
	if metadata := TraceMetadataFromContext(ctx); metadata != nil {
		attributes.Metadata = mergeMetadata(attributes.Metadata, metadata)
	}
	return attributes
}

// SpanAttributesFromTraceContext returns LogBrew span attributes from
// request-local trace context.
func SpanAttributesFromTraceContext(input TraceContextSpanInput) (SpanAttributes, error) {
	if err := requireNonEmpty("span name", input.Name); err != nil {
		return SpanAttributes{}, err
	}
	if err := requireTraceID(input.Trace.TraceID); err != nil {
		return SpanAttributes{}, err
	}
	if err := requireSpanID("span id", input.Trace.SpanID); err != nil {
		return SpanAttributes{}, err
	}
	if input.Trace.ParentSpanID != "" {
		if err := requireSpanID("parent span id", input.Trace.ParentSpanID); err != nil {
			return SpanAttributes{}, err
		}
	}
	if err := requireAllowedValue("span status", input.Status, spanStatuses); err != nil {
		return SpanAttributes{}, err
	}
	if input.DurationMs != nil && *input.DurationMs < 0 {
		return SpanAttributes{}, &SdkError{Code: "validation_error", Message: "span durationMs must be non-negative"}
	}
	return SpanAttributes{
		Name:         input.Name,
		TraceID:      input.Trace.TraceID,
		SpanID:       input.Trace.SpanID,
		ParentSpanID: input.Trace.ParentSpanID,
		Status:       input.Status,
		DurationMs:   input.DurationMs,
		Metadata:     compactMetadata(input.Metadata),
		Links:        input.Links,
	}, nil
}

func mergeMetadata(base map[string]any, additions map[string]any) map[string]any {
	merged := compactMetadata(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range compactMetadata(additions) {
		merged[key] = value
	}
	if len(merged) == 0 {
		return nil
	}
	return merged
}

func randomHexID(byteCount int, forbidden string) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", &SdkError{Code: "runtime_error", Message: "could not generate trace context id"}
	}
	value := hex.EncodeToString(buffer)
	if value == forbidden {
		buffer[len(buffer)-1] = 1
		value = hex.EncodeToString(buffer)
	}
	return value, nil
}
