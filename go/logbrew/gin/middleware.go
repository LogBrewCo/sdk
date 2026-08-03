// Package logbrewgin provides privacy-bounded Gin request telemetry for the
// LogBrew Go SDK.
package logbrewgin

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"github.com/gin-gonic/gin"
)

const (
	defaultEventIDPrefix = "go_gin"
	defaultMetricName    = "http.server.duration"
	unmatchedRoute       = "<unmatched>"
)

// Filter decides whether a Gin request should receive LogBrew request
// telemetry. Return false to leave the request uninstrumented.
type Filter func(*gin.Context) bool

// Config controls the Gin middleware while leaving transport, retry, flush,
// and shutdown ownership with the application and the core LogBrew client.
type Config struct {
	// Client receives request spans, optional duration metrics, and request
	// issues. It must be non-nil.
	Client *logbrew.Client
	// CaptureRequestMetrics emits one http.server.duration histogram for each
	// instrumented request. It is false by default.
	CaptureRequestMetrics bool
	// CaptureServerErrorIssues emits a generic issue for completed 5xx
	// responses. Panic issues are always captured when this middleware observes
	// the panic, regardless of this setting.
	CaptureServerErrorIssues bool
	// Filter can skip health checks or other app-selected requests. A skipped
	// request receives no LogBrew trace context or automatic events.
	Filter Filter
	// EventIDPrefix prefixes generated event IDs. Empty defaults to go_gin.
	EventIDPrefix string
	// MetricName names opt-in request duration metrics. Empty defaults to
	// http.server.duration.
	MetricName string
	// Metadata adds primitive, low-cardinality app context. Keys that suggest
	// credentials, payloads, URLs, headers, queries, or raw propagation are
	// dropped.
	Metadata map[string]any
	// SpanIDFactory optionally supplies request span IDs. Production callers
	// normally leave this nil so the core SDK generates IDs.
	SpanIDFactory func() string
	// Now optionally supplies timestamps for controlled tests.
	Now func() time.Time
	// OnError receives capture failures after request work continues. Panics in
	// this callback are ignored so they cannot change the app response.
	OnError func(error)
}

type middleware struct {
	client                   *logbrew.Client
	captureRequestMetrics    bool
	captureServerErrorIssues bool
	filter                   Filter
	eventIDPrefix            string
	metricName               string
	metadata                 map[string]any
	spanIDFactory            func() string
	now                      func() time.Time
	onError                  func(error)
	counter                  atomic.Uint64
}

// NewMiddleware returns Gin middleware that attaches a request-local LogBrew
// trace and queues one privacy-bounded request span. It does not create a
// client or transport, flush, recover the application, or change Gin's
// response lifecycle.
func NewMiddleware(config Config) (gin.HandlerFunc, error) {
	if config.Client == nil {
		return nil, &logbrew.SdkError{Code: "configuration_error", Message: "Gin middleware client must be non-nil"}
	}
	eventIDPrefix := strings.TrimSpace(config.EventIDPrefix)
	if eventIDPrefix == "" {
		eventIDPrefix = defaultEventIDPrefix
	}
	metricName := strings.TrimSpace(config.MetricName)
	if metricName == "" {
		metricName = defaultMetricName
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	instrumentation := &middleware{
		client:                   config.Client,
		captureRequestMetrics:    config.CaptureRequestMetrics,
		captureServerErrorIssues: config.CaptureServerErrorIssues,
		filter:                   config.Filter,
		eventIDPrefix:            eventIDPrefix,
		metricName:               metricName,
		metadata:                 safeMetadata(config.Metadata),
		spanIDFactory:            config.SpanIDFactory,
		now:                      now,
		onError:                  config.OnError,
	}
	return instrumentation.handle, nil
}

// TraceFromContext returns the request-local LogBrew trace attached by this
// middleware, when one is active.
func TraceFromContext(c *gin.Context) (logbrew.TraceContext, bool) {
	if c == nil || c.Request == nil {
		return logbrew.TraceContext{}, false
	}
	return logbrew.LogBrewTraceFromContext(c.Request.Context())
}

func (m *middleware) handle(c *gin.Context) {
	if m.filter != nil && !m.filter(c) {
		c.Next()
		return
	}

	started, trace, traceErr := m.initializeRequestTelemetry(c.Request)
	if traceErr != nil {
		m.report(traceErr)
	}
	if trace.TraceID == "" {
		c.Next()
		return
	}
	c.Request = c.Request.WithContext(logbrew.ContextWithLogBrewTrace(c.Request.Context(), trace))

	defer func() {
		if recovered := recover(); recovered != nil {
			m.captureSafely(c, trace, started, panicStatusCode(c), recovered, logbrew.CaptureIssueStackFrames())
			panic(recovered)
		}
		m.captureSafely(c, trace, started, normalizeStatusCode(c.Writer.Status()), nil, nil)
	}()

	c.Next()
}

func (m *middleware) initializeRequestTelemetry(request *http.Request) (
	started time.Time,
	trace logbrew.TraceContext,
	err error,
) {
	defer func() {
		if recover() != nil {
			started = time.Time{}
			trace = logbrew.TraceContext{}
			err = &logbrew.SdkError{Code: "capture_error", Message: "Gin request telemetry skipped"}
		}
	}()
	started = m.now()
	trace, err = m.requestTrace(request)
	return started, trace, err
}

func (m *middleware) requestTrace(request *http.Request) (logbrew.TraceContext, error) {
	spanID, spanIDErr := safeSpanID(m.spanIDFactory)
	if spanIDErr != nil {
		fallback, fallbackErr := logbrew.NewTraceContext(logbrew.TraceContextInput{})
		if fallbackErr != nil {
			return logbrew.TraceContext{}, fallbackErr
		}
		return fallback, spanIDErr
	}

	traceparents := []string(nil)
	if request != nil {
		traceparents = request.Header.Values("traceparent")
	}
	if len(traceparents) == 0 && request != nil {
		if parent, ok := logbrew.LogBrewTraceFromContext(request.Context()); ok {
			traceFlags := strings.TrimSpace(parent.TraceFlags)
			if traceFlags == "" {
				traceFlags = "00"
				if parent.Sampled {
					traceFlags = "01"
				}
			}
			traceparent, err := logbrew.CreateTraceparent(parent.TraceID, parent.SpanID, traceFlags)
			if err == nil {
				return logbrew.NewTraceContext(logbrew.TraceContextInput{
					Traceparent: traceparent,
					SpanID:      spanID,
				})
			}
			fallback, fallbackErr := logbrew.NewTraceContext(logbrew.TraceContextInput{SpanID: spanID})
			if fallbackErr != nil {
				return logbrew.TraceContext{}, fallbackErr
			}
			return fallback, &logbrew.SdkError{Code: "capture_error", Message: "Gin active trace skipped"}
		}
	}
	if len(traceparents) == 1 && strings.TrimSpace(traceparents[0]) != "" {
		trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
			Traceparent: traceparents[0],
			SpanID:      spanID,
		})
		if err == nil {
			return trace, nil
		}
	}
	fallback, fallbackErr := logbrew.NewTraceContext(logbrew.TraceContextInput{SpanID: spanID})
	if fallbackErr != nil {
		return logbrew.TraceContext{}, fallbackErr
	}
	if len(traceparents) > 0 {
		return fallback, &logbrew.SdkError{Code: "capture_error", Message: "Gin traceparent skipped"}
	}
	return fallback, nil
}

func safeSpanID(factory func() string) (spanID string, err error) {
	if factory == nil {
		return "", nil
	}
	defer func() {
		if recover() != nil {
			spanID = ""
			err = &logbrew.SdkError{Code: "capture_error", Message: "Gin span ID factory failed"}
		}
	}()
	spanID = strings.TrimSpace(factory())
	if spanID == "" {
		return "", nil
	}
	_, validationErr := logbrew.CreateTraceparent(strings.Repeat("1", 32), spanID, "00")
	if validationErr != nil {
		return "", &logbrew.SdkError{Code: "capture_error", Message: "Gin span ID factory returned an invalid value"}
	}
	return spanID, nil
}

func (m *middleware) captureSafely(
	c *gin.Context,
	trace logbrew.TraceContext,
	started time.Time,
	statusCode int,
	recovered any,
	panicFrames []logbrew.IssueStackFrame,
) {
	defer func() {
		if recover() != nil {
			m.report(&logbrew.SdkError{Code: "capture_error", Message: "Gin request telemetry capture failed"})
		}
	}()
	m.capture(c, trace, started, statusCode, recovered, panicFrames)
}

func (m *middleware) capture(
	c *gin.Context,
	trace logbrew.TraceContext,
	started time.Time,
	statusCode int,
	recovered any,
	panicFrames []logbrew.IssueStackFrame,
) {
	finished := m.now()
	durationMs := float64(finished.Sub(started).Microseconds()) / 1000
	if durationMs < 0 {
		durationMs = 0
	}
	method := safeHTTPMethod(c.Request.Method)
	routeTemplate := safeRouteTemplate(c.FullPath())
	metadata := mergeMetadata(m.metadata, map[string]any{
		"framework":       "gin",
		"method":          method,
		"routeTemplate":   routeTemplate,
		"sampled":         trace.Sampled,
		"source":          "gin.request",
		"statusCode":      statusCode,
		"statusCodeClass": statusCodeClass(statusCode),
	})
	if len(c.Errors) > 0 {
		metadata["ginErrorCount"] = len(c.Errors)
	}
	if recovered != nil {
		metadata["panic"] = true
		metadata["panicType"] = panicType(recovered)
	}
	spanStatus := "ok"
	if recovered != nil || statusCode >= http.StatusInternalServerError || len(c.Errors) > 0 {
		spanStatus = "error"
	}
	span, spanErr := logbrew.SpanAttributesFromTraceContext(logbrew.TraceContextSpanInput{
		Trace:      trace,
		Name:       fmt.Sprintf("%s %s", method, routeTemplate),
		Status:     spanStatus,
		DurationMs: &durationMs,
		Metadata:   metadata,
	})
	timestamp := finished.UTC().Format(time.RFC3339Nano)
	if spanErr != nil {
		m.report(spanErr)
	} else if err := m.client.Span(m.eventID("span"), timestamp, span); err != nil {
		m.report(err)
	}

	if recovered != nil || (m.captureServerErrorIssues && statusCode >= http.StatusInternalServerError) {
		title := "Gin request returned a server error"
		if recovered != nil {
			title = "Gin request panicked"
		}
		issueAttributes := logbrew.IssueAttributes{
			Title:    title,
			Level:    "error",
			Metadata: metadata,
		}
		if recovered != nil {
			issueAttributes.Exception = &logbrew.IssueException{
				Type: panicType(recovered),
				Mechanism: &logbrew.IssueExceptionMechanism{
					Type:    "gin.recovery",
					Handled: false,
				},
			}
			issueAttributes.StackFrames = panicFrames
		}
		issue := logbrew.IssueAttributesWithTrace(c.Request.Context(), issueAttributes)
		if err := m.client.Issue(m.eventID("issue"), timestamp, issue); err != nil {
			m.report(err)
		}
	}

	if m.captureRequestMetrics {
		metricMetadata := mergeMetadata(metadata, trace.Metadata())
		metric := logbrew.MetricAttributesWithTrace(c.Request.Context(), logbrew.MetricAttributes{
			Name:        m.metricName,
			Kind:        "histogram",
			Value:       durationMs,
			Unit:        "ms",
			Temporality: "delta",
			Metadata:    metricMetadata,
		})
		if err := m.client.Metric(m.eventID("metric"), timestamp, metric); err != nil {
			m.report(err)
		}
	}
}

func (m *middleware) eventID(kind string) string {
	return fmt.Sprintf("%s_%s_%d", m.eventIDPrefix, kind, m.counter.Add(1))
}

func (m *middleware) report(err error) {
	if err == nil || m.onError == nil {
		return
	}
	defer func() {
		_ = recover()
	}()
	m.onError(err)
}

func normalizeStatusCode(statusCode int) int {
	if statusCode < 100 || statusCode > 599 {
		return http.StatusOK
	}
	return statusCode
}

func panicStatusCode(c *gin.Context) int {
	if c != nil && c.Writer != nil && c.Writer.Written() {
		return normalizeStatusCode(c.Writer.Status())
	}
	return http.StatusInternalServerError
}

func statusCodeClass(statusCode int) string {
	if statusCode < 100 || statusCode > 599 {
		return "unknown"
	}
	return fmt.Sprintf("%dxx", statusCode/100)
}

func panicType(recovered any) string {
	switch recovered.(type) {
	case error:
		return "error"
	case string:
		return "string"
	default:
		return "other"
	}
}

func safeHTTPMethod(method string) string {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodConnect, http.MethodDelete, http.MethodGet, http.MethodHead,
		http.MethodOptions, http.MethodPatch, http.MethodPost, http.MethodPut, http.MethodTrace:
		return strings.ToUpper(strings.TrimSpace(method))
	default:
		return "OTHER"
	}
}

func safeRouteTemplate(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return unmatchedRoute
	}
	if parsed, err := url.Parse(value); err == nil && (parsed.IsAbs() || parsed.Host != "") {
		value = parsed.Path
	}
	if index := strings.IndexAny(value, "?#"); index >= 0 {
		value = value[:index]
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return unmatchedRoute
	}
	return value
}

func mergeMetadata(base, additions map[string]any) map[string]any {
	merged := safeMetadata(base)
	if merged == nil {
		merged = map[string]any{}
	}
	for key, value := range safeMetadata(additions) {
		merged[key] = value
	}
	return merged
}

func safeMetadata(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	metadata := make(map[string]any)
	for key, value := range input {
		if strings.TrimSpace(key) == "" || blockedMetadataKey(key) {
			continue
		}
		switch value.(type) {
		case string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			metadata[key] = value
		}
	}
	if len(metadata) == 0 {
		return nil
	}
	return metadata
}

func blockedMetadataKey(key string) bool {
	normalized := strings.NewReplacer("_", "", "-", "", ".", "").Replace(strings.ToLower(strings.TrimSpace(key)))
	for _, blocked := range []string{
		"accountid", "args", "arguments", "auth", "authorization", "baggage", "body", "brokerurl",
		"command", "connectionstring", "cookie", "cookies", "dsn", "email", "endpoint", "headers",
		"host", "hostname", "ipaddress", "key", "message", "params", "parameters", "password", "path",
		"payload", "query", "remoteaddress", "secret", "sql", "stack", "statement", "token",
		"traceparent", "tracestate", "url", "userid", "username", "useremail", "value",
	} {
		if normalized == blocked || strings.Contains(normalized, blocked) {
			return true
		}
	}
	return false
}
