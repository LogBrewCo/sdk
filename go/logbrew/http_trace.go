package logbrew

import (
	"fmt"
	"net/http"
	"sync/atomic"
	"time"
)

// HTTPHandlerConfig configures dependency-free net/http request telemetry.
type HTTPHandlerConfig struct {
	Client               *Client
	RouteTemplate        string
	CaptureRequestMetric bool
	EventIDPrefix        string
	Metadata             map[string]any
	SpanIDFactory        func() string
	Now                  func() time.Time
	OnError              func(error)
}

// NewHTTPHandler wraps an app-owned net/http handler with privacy-safe request
// span telemetry and request-local trace context.
func NewHTTPHandler(next http.Handler, config HTTPHandlerConfig) (http.Handler, error) {
	if next == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP handler must be non-nil"}
	}
	if config.Client == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP handler client must be non-nil"}
	}
	prefix := config.EventIDPrefix
	if prefix == "" {
		prefix = "go_http"
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	handler := &httpTraceHandler{
		next:   next,
		config: config,
		prefix: prefix,
		now:    now,
	}
	return handler, nil
}

// NewHTTPHandlerFunc wraps an app-owned net/http handler function.
func NewHTTPHandlerFunc(next http.HandlerFunc, config HTTPHandlerConfig) (http.Handler, error) {
	if next == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP handler must be non-nil"}
	}
	return NewHTTPHandler(http.HandlerFunc(next), config)
}

type httpTraceHandler struct {
	next    http.Handler
	config  HTTPHandlerConfig
	prefix  string
	now     func() time.Time
	counter atomic.Uint64
}

func (h *httpTraceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := h.now()
	trace, traceErr := h.requestTrace(r)
	if traceErr != nil {
		h.report(traceErr)
	}
	if traceErr != nil {
		h.next.ServeHTTP(w, r)
		return
	}

	recorder := &statusRecordingResponseWriter{ResponseWriter: w}
	requestWithTrace := r.WithContext(ContextWithLogBrewTrace(r.Context(), trace))
	h.next.ServeHTTP(recorder, requestWithTrace)

	statusCode := recorder.Status()
	durationMs := float64(h.now().Sub(start).Microseconds()) / 1000
	routeTemplate := h.routeTemplate(requestWithTrace)
	metadata := mergeMetadata(h.config.Metadata, map[string]any{
		"method":        requestWithTrace.Method,
		"routeTemplate": routeTemplate,
		"sampled":       trace.Sampled,
		"statusCode":    statusCode,
	})
	metricMetadata := mergeMetadata(metadata, trace.Metadata())
	span, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      trace,
		Name:       fmt.Sprintf("%s %s", requestWithTrace.Method, routeTemplate),
		Status:     spanStatusFromHTTPStatus(statusCode),
		DurationMs: &durationMs,
		Metadata:   metadata,
	})
	if err != nil {
		h.report(err)
		return
	}
	if err := h.config.Client.Span(h.eventID("span"), h.timestamp(), span); err != nil {
		h.report(err)
	}
	if h.config.CaptureRequestMetric {
		if err := h.config.Client.Metric(h.eventID("metric"), h.timestamp(), MetricAttributes{
			Name:        "http.server.duration",
			Kind:        "histogram",
			Value:       durationMs,
			Unit:        "ms",
			Temporality: "delta",
			Metadata:    metricMetadata,
		}); err != nil {
			h.report(err)
		}
	}
}

func (h *httpTraceHandler) requestTrace(r *http.Request) (TraceContext, error) {
	spanID := ""
	if h.config.SpanIDFactory != nil {
		spanID = h.config.SpanIDFactory()
	}
	trace, err := NewTraceContext(TraceContextInput{
		Traceparent: r.Header.Get("traceparent"),
		SpanID:      spanID,
	})
	if err == nil {
		return trace, nil
	}
	return NewTraceContext(TraceContextInput{SpanID: spanID})
}

func (h *httpTraceHandler) routeTemplate(r *http.Request) string {
	routeTemplate := "/"
	if h.config.RouteTemplate != "" {
		routeTemplate = sanitizeRouteTemplate(h.config.RouteTemplate)
	} else if r.Pattern != "" {
		routeTemplate = sanitizeRouteTemplate(r.Pattern)
	} else if r.URL != nil {
		routeTemplate = sanitizeRouteTemplate(r.URL.Path)
	}
	if routeTemplate == "" {
		return "/"
	}
	return routeTemplate
}

func (h *httpTraceHandler) timestamp() string {
	return h.now().UTC().Format(time.RFC3339Nano)
}

func (h *httpTraceHandler) eventID(kind string) string {
	return fmt.Sprintf("%s_%s_%d", h.prefix, kind, h.counter.Add(1))
}

func (h *httpTraceHandler) report(err error) {
	if err != nil && h.config.OnError != nil {
		h.config.OnError(err)
	}
}

type statusRecordingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusRecordingResponseWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *statusRecordingResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusRecordingResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}

func (w *statusRecordingResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *statusRecordingResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func spanStatusFromHTTPStatus(statusCode int) string {
	if statusCode >= 500 {
		return "error"
	}
	return "ok"
}
