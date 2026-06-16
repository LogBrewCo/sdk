package logbrew

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"sync/atomic"
	"time"
)

// SlogHandlerConfig configures a slog handler that preserves app-owned logging
// while also queueing LogBrew log events.
type SlogHandlerConfig struct {
	Client        *Client
	Wrapped       slog.Handler
	Logger        string
	EventIDPrefix string
	Metadata      map[string]any
	Now           func() time.Time
	OnError       func(error)
}

// NewSlogHandler wraps an app-owned slog.Handler and correlates logs with the
// LogBrew trace context stored on the provided context.
func NewSlogHandler(config SlogHandlerConfig) (slog.Handler, error) {
	if config.Client == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "slog handler client must be non-nil"}
	}
	prefix := config.EventIDPrefix
	if prefix == "" {
		prefix = "go_slog"
	}
	if config.Logger == "" {
		config.Logger = "slog"
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &logbrewSlogHandler{
		config:  config,
		prefix:  prefix,
		now:     now,
		counter: &atomic.Uint64{},
	}, nil
}

type logbrewSlogHandler struct {
	config  SlogHandlerConfig
	prefix  string
	now     func() time.Time
	attrs   []slog.Attr
	counter *atomic.Uint64
}

func (h *logbrewSlogHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.config.Wrapped == nil || h.config.Wrapped.Enabled(ctx, level)
}

func (h *logbrewSlogHandler) Handle(ctx context.Context, record slog.Record) error {
	metadata := mergeMetadata(h.config.Metadata, slogMetadata(h.attrs))
	metadata = mergeMetadata(metadata, slogRecordMetadata(record))
	metadata = mergeMetadata(metadata, TraceMetadataFromContext(ctx))
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["source"] = "slog"

	if err := h.config.Client.Log(h.eventID(), h.timestamp(record), LogAttributes{
		Message:  record.Message,
		Level:    slogLevel(record.Level),
		Logger:   h.config.Logger,
		Metadata: metadata,
	}); err != nil {
		h.report(err)
	}

	wrappedRecord := record.Clone()
	if trace, ok := LogBrewTraceFromContext(ctx); ok {
		wrappedRecord.AddAttrs(
			slog.String("traceId", trace.TraceID),
			slog.String("spanId", trace.SpanID),
		)
		if trace.ParentSpanID != "" {
			wrappedRecord.AddAttrs(slog.String("parentSpanId", trace.ParentSpanID))
		}
	}
	if h.config.Wrapped == nil {
		return nil
	}
	return h.config.Wrapped.Handle(ctx, wrappedRecord)
}

func (h *logbrewSlogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	cloned := h.clone()
	cloned.attrs = append(cloned.attrs, attrs...)
	if cloned.config.Wrapped != nil {
		cloned.config.Wrapped = cloned.config.Wrapped.WithAttrs(attrs)
	}
	return cloned
}

func (h *logbrewSlogHandler) WithGroup(name string) slog.Handler {
	cloned := h.clone()
	if cloned.config.Wrapped != nil {
		cloned.config.Wrapped = cloned.config.Wrapped.WithGroup(name)
	}
	return cloned
}

func (h *logbrewSlogHandler) clone() *logbrewSlogHandler {
	return &logbrewSlogHandler{
		config:  h.config,
		prefix:  h.prefix,
		now:     h.now,
		attrs:   append([]slog.Attr{}, h.attrs...),
		counter: h.counter,
	}
}

func (h *logbrewSlogHandler) eventID() string {
	return fmt.Sprintf("%s_%d", h.prefix, h.counter.Add(1))
}

func (h *logbrewSlogHandler) timestamp(record slog.Record) string {
	if !record.Time.IsZero() {
		return record.Time.UTC().Format(time.RFC3339Nano)
	}
	return h.now().UTC().Format(time.RFC3339Nano)
}

func (h *logbrewSlogHandler) report(err error) {
	if err != nil && h.config.OnError != nil {
		h.config.OnError(err)
	}
}

func slogLevel(level slog.Level) string {
	switch {
	case level >= slog.LevelError:
		return "error"
	case level >= slog.LevelWarn:
		return "warning"
	default:
		return "info"
	}
}

func slogMetadata(attrs []slog.Attr) map[string]any {
	metadata := map[string]any{}
	for _, attr := range attrs {
		addSlogAttr(metadata, attr)
	}
	return compactMetadata(metadata)
}

func slogRecordMetadata(record slog.Record) map[string]any {
	metadata := map[string]any{}
	record.Attrs(func(attr slog.Attr) bool {
		addSlogAttr(metadata, attr)
		return true
	})
	return compactMetadata(metadata)
}

func addSlogAttr(metadata map[string]any, attr slog.Attr) {
	if attr.Key == "" {
		return
	}
	value := attr.Value.Resolve()
	switch value.Kind() {
	case slog.KindString:
		metadata[attr.Key] = value.String()
	case slog.KindBool:
		metadata[attr.Key] = value.Bool()
	case slog.KindInt64:
		metadata[attr.Key] = value.Int64()
	case slog.KindUint64:
		metadata[attr.Key] = strconv.FormatUint(value.Uint64(), 10)
	case slog.KindFloat64:
		metadata[attr.Key] = value.Float64()
	}
}
