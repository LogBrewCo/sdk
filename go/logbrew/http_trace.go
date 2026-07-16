package logbrew

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"strings"
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

// HTTPHandlerOption adds explicit behavior without changing the stable
// HTTPHandlerConfig layout.
type HTTPHandlerOption interface {
	applyHTTPHandlerOption(*httpHandlerOptions)
}

type httpHandlerOptionFunc func(*httpHandlerOptions)

func (option httpHandlerOptionFunc) applyHTTPHandlerOption(options *httpHandlerOptions) {
	option(options)
}

type httpHandlerOptions struct {
	captureServerErrorIssue bool
}

// WithHTTPServerErrorIssues adds one generic correlated issue for ordinary
// 5xx responses. Panics always add a generic issue before being re-panicked.
func WithHTTPServerErrorIssues() HTTPHandlerOption {
	return httpHandlerOptionFunc(func(options *httpHandlerOptions) {
		options.captureServerErrorIssue = true
	})
}

// NewHTTPHandler wraps an app-owned net/http handler with privacy-safe request
// span telemetry and request-local trace context.
func NewHTTPHandler(next http.Handler, config HTTPHandlerConfig) (http.Handler, error) {
	return newHTTPHandler(next, config, nil)
}

// NewHTTPHandlerWithOptions wraps an app-owned handler with explicit additive
// behavior while preserving the stable HTTPHandlerConfig layout.
func NewHTTPHandlerWithOptions(
	next http.Handler,
	config HTTPHandlerConfig,
	options ...HTTPHandlerOption,
) (http.Handler, error) {
	return newHTTPHandler(next, config, options)
}

func newHTTPHandler(
	next http.Handler,
	config HTTPHandlerConfig,
	options []HTTPHandlerOption,
) (http.Handler, error) {
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
	config.Metadata = safeOperationMetadata(config.Metadata)
	if strings.TrimSpace(config.RouteTemplate) != "" {
		config.RouteTemplate = safeHTTPRoutePattern(config.RouteTemplate)
	}
	appliedOptions := httpHandlerOptions{}
	for _, option := range options {
		if option == nil {
			return nil, &SdkError{Code: "configuration_error", Message: "HTTP handler option must be non-nil"}
		}
		option.applyHTTPHandlerOption(&appliedOptions)
	}
	handler := &httpTraceHandler{
		next:                    next,
		config:                  config,
		captureServerErrorIssue: appliedOptions.captureServerErrorIssue,
		prefix:                  prefix,
		now:                     now,
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

// NewHTTPHandlerFuncWithOptions wraps an app-owned handler function with
// explicit additive behavior.
func NewHTTPHandlerFuncWithOptions(
	next http.HandlerFunc,
	config HTTPHandlerConfig,
	options ...HTTPHandlerOption,
) (http.Handler, error) {
	if next == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP handler must be non-nil"}
	}
	return NewHTTPHandlerWithOptions(http.HandlerFunc(next), config, options...)
}

type httpTraceHandler struct {
	next                    http.Handler
	config                  HTTPHandlerConfig
	captureServerErrorIssue bool
	prefix                  string
	now                     func() time.Time
	counter                 atomic.Uint64
}

type httpTraceOwnerContextKey struct{}

func (h *httpTraceHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Context().Value(httpTraceOwnerContextKey{}) != nil {
		h.next.ServeHTTP(w, r)
		return
	}
	start, trace, traceErr := h.initializeRequestTelemetry(r)
	if traceErr != nil {
		h.report(traceErr)
	}
	if trace.TraceID == "" {
		h.next.ServeHTTP(w, r)
		return
	}

	recorder := newStatusRecordingResponseWriter(w)
	wrappedWriter := wrapStatusRecordingResponseWriter(w, recorder)
	requestContext := context.WithValue(r.Context(), httpTraceOwnerContextKey{}, struct{}{})
	requestWithTrace := r.WithContext(ContextWithLogBrewTrace(requestContext, trace))
	defer func() {
		if recovered := recover(); recovered != nil {
			h.captureRequestTelemetrySafely(requestWithTrace, trace, start, recorder.StatusForPanic(), httpServerPanicMetadata(recovered), true)
			panic(recovered)
		}
	}()
	h.next.ServeHTTP(wrappedWriter, requestWithTrace)

	h.captureRequestTelemetrySafely(requestWithTrace, trace, start, recorder.Status(), nil, false)
}

func (h *httpTraceHandler) initializeRequestTelemetry(r *http.Request) (
	start time.Time,
	trace TraceContext,
	err error,
) {
	defer func() {
		if recover() != nil {
			start = time.Time{}
			trace = TraceContext{}
			err = &SdkError{Code: "capture_error", Message: "HTTP request telemetry skipped"}
		}
	}()
	start = h.now()
	trace, err = h.requestTrace(r)
	return start, trace, err
}

func (h *httpTraceHandler) captureRequestTelemetrySafely(
	request *http.Request,
	trace TraceContext,
	start time.Time,
	statusCode int,
	extraMetadata map[string]any,
	panicked bool,
) {
	defer func() {
		if recover() != nil {
			h.report(&SdkError{Code: "capture_error", Message: "HTTP request telemetry skipped"})
		}
	}()
	h.captureRequestTelemetry(request, trace, start, statusCode, extraMetadata, panicked)
}

func (h *httpTraceHandler) captureRequestTelemetry(
	request *http.Request,
	trace TraceContext,
	start time.Time,
	statusCode int,
	extraMetadata map[string]any,
	panicked bool,
) {
	finished := h.now()
	durationMs := float64(finished.Sub(start).Microseconds()) / 1000
	if durationMs < 0 {
		durationMs = 0
	}
	method := safeHTTPServerMethod(request.Method)
	routeTemplate := h.routeTemplate(request)
	metadata := mergeMetadata(safeOperationMetadata(h.config.Metadata), map[string]any{
		"method":        method,
		"routeTemplate": routeTemplate,
		"sampled":       trace.Sampled,
		"statusCode":    statusCode,
	})
	metadata = mergeMetadata(metadata, extraMetadata)
	metricMetadata := mergeMetadata(metadata, trace.Metadata())
	spanStatus := spanStatusFromHTTPStatus(statusCode)
	if panicked {
		spanStatus = "error"
	}
	span, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      trace,
		Name:       fmt.Sprintf("%s %s", method, routeTemplate),
		Status:     spanStatus,
		DurationMs: &durationMs,
		Metadata:   metadata,
	})
	if err != nil {
		h.report(err)
		return
	}
	timestamp := finished.UTC().Format(time.RFC3339Nano)
	if err := h.config.Client.Span(h.eventID("span"), timestamp, span); err != nil {
		h.report(err)
	}
	if panicked || (statusCode >= http.StatusInternalServerError && h.captureServerErrorIssue) {
		title := "HTTP server error response"
		if panicked {
			title = "HTTP server panic"
		}
		issue := IssueAttributesWithTrace(request.Context(), IssueAttributes{
			Title:    title,
			Level:    "error",
			Metadata: metadata,
		})
		if err := h.config.Client.Issue(h.eventID("issue"), timestamp, issue); err != nil {
			h.report(err)
		}
	}
	if h.config.CaptureRequestMetric {
		if err := h.config.Client.Metric(h.eventID("metric"), timestamp, MetricAttributes{
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

func httpServerPanicMetadata(recovered any) map[string]any {
	metadata := map[string]any{"panic": true}
	switch recovered.(type) {
	case error:
		metadata["panicType"] = "error"
	case string:
		metadata["panicType"] = "string"
	default:
		metadata["panicType"] = "other"
	}
	return metadata
}

func panicMetadata(recovered any) map[string]any {
	metadata := map[string]any{"panic": true}
	if recovered != nil {
		metadata["panicType"] = reflect.TypeOf(recovered).String()
	}
	return metadata
}

func (h *httpTraceHandler) requestTrace(r *http.Request) (TraceContext, error) {
	spanID, err := operationSpanID(h.config.SpanIDFactory)
	if err != nil {
		return TraceContext{}, err
	}
	traceparents := r.Header.Values("traceparent")
	if len(traceparents) == 0 {
		return operationChildTraceWithSpanID(r.Context(), spanID)
	}
	if len(traceparents) == 1 {
		if parent, ok := strictHTTPTraceparent(traceparents[0]); ok {
			return TraceContext{
				TraceID:      parent.TraceID,
				SpanID:       spanID,
				ParentSpanID: parent.ParentSpanID,
				TraceFlags:   parent.TraceFlags,
				Sampled:      parent.Sampled,
			}, nil
		}
	}
	fallback, fallbackErr := NewTraceContext(TraceContextInput{SpanID: spanID})
	if fallbackErr != nil {
		return TraceContext{}, fallbackErr
	}
	return fallback, &SdkError{Code: "capture_error", Message: "HTTP traceparent skipped"}
}

func strictHTTPTraceparent(value string) (TraceparentContext, bool) {
	if len(value) < 55 || strings.TrimSpace(value) != value || strings.Contains(value, ",") ||
		value[2] != '-' || value[35] != '-' || value[52] != '-' {
		return TraceparentContext{}, false
	}
	base := value[:55]
	if !isLowerHexASCII(base[0:2]) ||
		!isLowerHexASCII(base[3:35]) ||
		!isLowerHexASCII(base[36:52]) ||
		!isLowerHexASCII(base[53:55]) {
		return TraceparentContext{}, false
	}
	if base[0:2] == "00" {
		if len(value) != len(base) {
			return TraceparentContext{}, false
		}
	} else if len(value) > len(base) {
		if value[len(base)] != '-' || len(value) == len(base)+1 {
			return TraceparentContext{}, false
		}
		for _, char := range value[len(base)+1:] {
			if char <= ' ' || char > '~' || char == ',' {
				return TraceparentContext{}, false
			}
		}
	}
	parsed, err := ParseTraceparent(base)
	return parsed, err == nil
}

func isLowerHexASCII(value string) bool {
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func (h *httpTraceHandler) routeTemplate(r *http.Request) string {
	if h.config.RouteTemplate != "" {
		return h.config.RouteTemplate
	}
	return safeHTTPRoutePattern(r.Pattern)
}

func (h *httpTraceHandler) eventID(kind string) string {
	return fmt.Sprintf("%s_%s_%d", h.prefix, kind, h.counter.Add(1))
}

func (h *httpTraceHandler) report(err error) {
	if err != nil && h.config.OnError != nil {
		func() {
			defer func() {
				_ = recover()
			}()
			h.config.OnError(err)
		}()
	}
}

func safeHTTPServerMethod(method string) string {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodConnect, http.MethodDelete, http.MethodGet, http.MethodHead,
		http.MethodOptions, http.MethodPatch, http.MethodPost, http.MethodPut, http.MethodTrace:
		return strings.ToUpper(strings.TrimSpace(method))
	default:
		return "OTHER"
	}
}

func safeHTTPRoutePattern(pattern string) string {
	sanitized := sanitizeRouteTemplate(pattern)
	if strings.HasPrefix(sanitized, "/") {
		return sanitized
	}
	if slash := strings.Index(sanitized, "/"); slash >= 0 {
		return sanitizeRouteTemplate(sanitized[slash:])
	}
	return "/"
}

func spanStatusFromHTTPStatus(statusCode int) string {
	if statusCode >= 500 {
		return "error"
	}
	return "ok"
}
