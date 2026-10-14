package logbrew

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	httpCaptureErrorCode = "capture_error"
	httpErrorOutcome     = "error"
	httpHostLengthLimit  = 253
	httpHostLabelLimit   = 63
)

// HTTPClientTransportConfig configures dependency-free outbound net/http client spans.
type HTTPClientTransportConfig struct {
	Client *Client
	Base   http.RoundTripper
	// RouteTemplate is retained for source compatibility. Outbound tracing does not capture routes.
	RouteTemplate string
	// EventIDPrefix is a bounded local label used only to identify queued span events.
	EventIDPrefix string
	// Metadata is retained for source compatibility. Outbound tracing emits a fixed metadata allowlist.
	Metadata map[string]any
	// CapturePhaseTimings is retained for source compatibility. Transport internals are not captured.
	CapturePhaseTimings bool
	// FinishSpanOnResponseBodyClose defers span capture until the response body is read to EOF or closed.
	FinishSpanOnResponseBodyClose bool
	SpanIDFactory                 func() string
	Now                           func() time.Time
	OnError                       func(error)
}

// NewHTTPClientTransport wraps an app-owned RoundTripper with privacy-safe outbound spans.
func NewHTTPClientTransport(config HTTPClientTransportConfig) (http.RoundTripper, error) {
	if config.Client == nil {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP client transport client must be non-nil"}
	}
	base := config.Base
	if base == nil {
		base = http.DefaultTransport
	}
	if wrapped, ok := base.(*httpClientTraceTransport); ok {
		return wrapped, nil
	}
	prefix := config.EventIDPrefix
	if prefix == "" {
		prefix = "go_http_client"
	}
	if !isSafeHTTPClientLabel(prefix) {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP client transport event ID prefix must be a bounded label"}
	}
	config.RouteTemplate = ""
	config.Metadata = nil
	config.CapturePhaseTimings = false
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &httpClientTraceTransport{
		base:   base,
		config: config,
		prefix: prefix,
		now:    now,
	}, nil
}

type httpClientTraceTransport struct {
	base    http.RoundTripper
	config  HTTPClientTransportConfig
	prefix  string
	now     func() time.Time
	counter atomic.Uint64
}

// CloseIdleConnections forwards idle connection closure to the app-owned base.
func (t *httpClientTraceTransport) CloseIdleConnections() {
	if base, ok := t.base.(interface{ CloseIdleConnections() }); ok {
		base.CloseIdleConnections()
	}
}

type httpClientTraceContextKey uint8

const (
	httpClientTraceActiveKey httpClientTraceContextKey = iota
	httpClientTraceSDKDeliveryKey
)

type httpClientTraceOperation struct {
	request *http.Request
	active  *atomic.Bool
	trace   TraceContext
	method  string
	host    string
	start   time.Time
}

func (t *httpClientTraceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil {
		return t.base.RoundTrip(request)
	}

	requestContext := request.Context()

	active, _ := requestContext.Value(httpClientTraceActiveKey).(*atomic.Bool)
	if requestContext.Value(httpClientTraceSDKDeliveryKey) != nil || (active != nil && active.Load()) {
		return t.base.RoundTrip(request)
	}

	parent, ok := LogBrewTraceFromContext(requestContext)
	if !ok || validateTraceContext(parent) != nil {
		return t.base.RoundTrip(request)
	}

	operation, err := t.startOperation(request, parent)
	if err != nil {
		t.report(err)

		return t.base.RoundTrip(request)
	}
	defer func() {
		operation.active.Store(false)

		if recovered := recover(); recovered != nil {
			t.complete(operation, nil, &SdkError{Code: httpCaptureErrorCode, Message: "HTTP client transport panicked"})
			panic(recovered)
		}
	}()

	response, roundTripErr := t.base.RoundTrip(operation.request)
	operation.active.Store(false)
	operation.request = nil

	if t.shouldFinishOnResponseBody(response, roundTripErr) {
		response.Body = newHTTPClientTraceResponseBody(response.Body, requestContext.Err, func(bodyErr error) {
			t.complete(operation, response, bodyErr)
		})

		return response, nil
	}

	t.complete(operation, response, roundTripErr)

	return response, roundTripErr
}

func (t *httpClientTraceTransport) startOperation(request *http.Request, parent TraceContext) (operation *httpClientTraceOperation, err error) {
	defer func() {
		if recover() != nil {
			operation = nil
			err = httpClientTraceAdvisoryError("setup")
		}
	}()

	spanID := ""
	if t.config.SpanIDFactory != nil {
		spanID = t.config.SpanIDFactory()
	}
	spanID = strings.ToLower(strings.TrimSpace(spanID))
	if spanID == "" {
		spanID, err = GenerateSpanID()
		if err != nil {
			return nil, httpClientTraceAdvisoryError("setup")
		}
	}
	if requireSpanID("span id", spanID) != nil {
		return nil, httpClientTraceAdvisoryError("setup")
	}
	trace := TraceContext{
		TraceID:      parent.TraceID,
		SpanID:       spanID,
		ParentSpanID: parent.SpanID,
		TraceFlags:   normalizedTraceFlags(parent),
		Sampled:      parent.Sampled,
	}
	traceparent, err := CreateTraceparent(trace.TraceID, trace.SpanID, trace.TraceFlags)
	if err != nil {
		return nil, httpClientTraceAdvisoryError("setup")
	}

	clonedContext := ContextWithLogBrewTrace(request.Context(), trace)
	active := &atomic.Bool{}
	active.Store(true)
	clonedContext = context.WithValue(clonedContext, httpClientTraceActiveKey, active)
	cloned := request.Clone(clonedContext)

	cloned.Header = request.Header.Clone()
	if cloned.Header == nil {
		cloned.Header = make(http.Header)
	}

	cloned.Header.Del("traceparent")
	cloned.Header.Set("traceparent", traceparent)

	return &httpClientTraceOperation{
		request: cloned,
		active:  active,
		trace:   trace,
		method:  safeHTTPServerMethod(request.Method),
		host:    normalizedHTTPClientHost(request),
		start:   t.now(),
	}, nil
}

func (t *httpClientTraceTransport) complete(operation *httpClientTraceOperation, response *http.Response, roundTripErr error) {
	defer func() {
		if recover() != nil {
			t.report(httpClientTraceAdvisoryError("capture"))
		}
	}()
	finished := t.now()
	duration := finished.Sub(operation.start)
	if duration < 0 {
		duration = 0
	}
	t.captureSpan(operation, response, roundTripErr, duration, finished)
}

func (t *httpClientTraceTransport) shouldFinishOnResponseBody(response *http.Response, roundTripErr error) bool {
	return t.config.FinishSpanOnResponseBodyClose &&
		roundTripErr == nil &&
		response != nil &&
		response.Body != nil &&
		response.Body != http.NoBody
}

func newHTTPClientTraceResponseBody(body io.ReadCloser, requestError func() error, finish func(error)) io.ReadCloser {
	wrapped := &httpClientTraceResponseBody{
		body:         body,
		requestError: requestError,
		finish:       finish,
	}
	if writer, ok := body.(io.Writer); ok {
		return &httpClientTraceReadWriteCloser{httpClientTraceResponseBody: wrapped, writer: writer}
	}
	return wrapped
}

type httpClientTraceResponseBody struct {
	body         io.ReadCloser
	requestError func() error
	finish       func(error)
	once         sync.Once
}

func (b *httpClientTraceResponseBody) Read(p []byte) (int, error) {
	defer b.finishOnPanic()

	n, err := b.body.Read(p)
	if err == io.EOF {
		b.finishOnce(nil)
	} else if err != nil {
		b.finishOnce(err)
	}
	return n, err
}

func (b *httpClientTraceResponseBody) Close() error {
	defer b.finishOnPanic()

	err := b.body.Close()

	spanErr := err
	if spanErr == nil {
		spanErr = b.requestError()
	}

	b.finishOnce(spanErr)

	return err
}

func (b *httpClientTraceResponseBody) finishOnce(err error) {
	b.once.Do(func() { b.finish(err) })
}

func (b *httpClientTraceResponseBody) finishOnPanic() {
	if recovered := recover(); recovered != nil {
		b.finishOnce(&SdkError{Code: httpCaptureErrorCode, Message: "HTTP client response body panicked"})
		panic(recovered)
	}
}

type httpClientTraceReadWriteCloser struct {
	*httpClientTraceResponseBody
	writer io.Writer
}

func (b *httpClientTraceReadWriteCloser) Write(p []byte) (int, error) {
	defer b.finishOnPanic()

	n, err := b.writer.Write(p)
	if err != nil {
		b.finishOnce(err)
	}
	return n, err
}

func (t *httpClientTraceTransport) captureSpan(
	operation *httpClientTraceOperation,
	response *http.Response,
	roundTripErr error,
	duration time.Duration,
	finished time.Time,
) {
	statusCode := 0
	if response != nil {
		statusCode = response.StatusCode
	}
	durationMs := float64(duration.Microseconds()) / 1000
	metadata := map[string]any{
		"source":  "net/http.client",
		"method":  operation.method,
		"sampled": operation.trace.Sampled,
	}
	if operation.host != "" {
		metadata["host"] = operation.host
	}
	if statusCode > 0 {
		metadata["statusCode"] = statusCode
	}
	if roundTripErr != nil {
		metadata["errorType"] = classifyHTTPClientError(roundTripErr)
		if errors.Is(roundTripErr, context.Canceled) {
			metadata["cancelled"] = true
		}
	}
	span, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      operation.trace,
		Name:       "HTTP " + operation.method,
		Status:     spanStatusFromHTTPClientResult(statusCode, roundTripErr),
		DurationMs: &durationMs,
		Metadata:   metadata,
	})
	if err != nil {
		t.report(err)
		return
	}
	if err := t.config.Client.Span(t.eventID(), finished.UTC().Format(time.RFC3339Nano), span); err != nil {
		t.report(err)
	}
}

func classifyHTTPClientError(err error) string {
	switch {
	case errors.Is(err, context.Canceled):
		return "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	default:
		var networkError net.Error
		if errors.As(err, &networkError) {
			return "network"
		}
		return "transport"
	}
}

func normalizedHTTPClientHost(request *http.Request) string {
	if request.URL == nil {
		return ""
	}

	host := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(request.URL.Hostname()), "."))
	if host == "" || len(host) > httpHostLengthLimit || net.ParseIP(host) != nil || strings.Contains(host, ":") {
		return ""
	}

	if isNumericHTTPClientHost(host) {
		return ""
	}

	for label := range strings.SplitSeq(host, ".") {
		if !validHTTPClientHostLabel(label) {
			return ""
		}
	}

	return host
}

func isNumericHTTPClientHost(host string) bool {
	for _, char := range host {
		if (char < '0' || char > '9') && char != '.' {
			return false
		}
	}

	return true
}

func validHTTPClientHostLabel(label string) bool {
	if len(label) == 0 || len(label) > httpHostLabelLimit || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}

	for _, char := range label {
		if !validHTTPClientHostCharacter(char) {
			return false
		}
	}

	return true
}

func validHTTPClientHostCharacter(char rune) bool {
	return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char == '-'
}

func isSafeHTTPClientLabel(label string) bool {
	if len(label) == 0 || len(label) > 64 {
		return false
	}
	for _, char := range label {
		if !((char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.') {
			return false
		}
	}
	return true
}

func validateTraceContext(trace TraceContext) error {
	if err := requireTraceID(trace.TraceID); err != nil {
		return err
	}
	if err := requireSpanID("parent span id", trace.SpanID); err != nil {
		return err
	}
	if err := requireTraceFlags(normalizedTraceFlags(trace)); err != nil {
		return err
	}
	return nil
}

func normalizedTraceFlags(trace TraceContext) string {
	flags := trace.TraceFlags
	if flags == "" {
		flags = "00"
		if trace.Sampled {
			flags = "01"
		}
	}
	return flags
}

func (t *httpClientTraceTransport) eventID() string {
	return fmt.Sprintf("%s_span_%d", t.prefix, t.counter.Add(1))
}

func (t *httpClientTraceTransport) report(err error) {
	if err == nil || t.config.OnError == nil {
		return
	}
	defer func() { _ = recover() }()
	t.config.OnError(err)
}

func spanStatusFromHTTPClientResult(statusCode int, err error) string {
	if err != nil || statusCode >= 400 {
		return httpErrorOutcome
	}

	return "ok"
}

func httpClientTraceAdvisoryError(stage string) error {
	return &SdkError{Code: httpCaptureErrorCode, Message: "HTTP client tracing " + stage + " failed"}
}

func markLogBrewHTTPDelivery(request *http.Request) *http.Request {
	if request == nil {
		return nil
	}
	return request.WithContext(context.WithValue(request.Context(), httpClientTraceSDKDeliveryKey, true))
}
