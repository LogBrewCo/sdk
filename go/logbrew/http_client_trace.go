package logbrew

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync/atomic"
	"time"
)

// HTTPClientTransportConfig configures dependency-free outbound net/http client spans.
type HTTPClientTransportConfig struct {
	Client        *Client
	Base          http.RoundTripper
	RouteTemplate string
	EventIDPrefix string
	Metadata      map[string]any
	SpanIDFactory func() string
	Now           func() time.Time
	OnError       func(error)
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
	prefix := config.EventIDPrefix
	if prefix == "" {
		prefix = "go_http_client"
	}
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

func (t *httpClientTraceTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request == nil {
		return t.base.RoundTrip(request)
	}
	trace, traceErr := t.childTrace(request)
	if traceErr != nil {
		t.report(traceErr)
		if trace.TraceID == "" {
			return t.base.RoundTrip(request)
		}
	}
	tracedRequest, err := t.cloneRequestWithTrace(request, trace)
	if err != nil {
		t.report(err)
		return t.base.RoundTrip(request)
	}

	start := t.now()
	response, roundTripErr := t.base.RoundTrip(tracedRequest)
	finished := t.now()
	t.captureSpan(tracedRequest, trace, response, roundTripErr, finished.Sub(start), finished)
	return response, roundTripErr
}

func (t *httpClientTraceTransport) childTrace(request *http.Request) (TraceContext, error) {
	spanID := ""
	if t.config.SpanIDFactory != nil {
		spanID = t.config.SpanIDFactory()
	}
	parent, ok := LogBrewTraceFromContext(request.Context())
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

func (t *httpClientTraceTransport) cloneRequestWithTrace(request *http.Request, trace TraceContext) (*http.Request, error) {
	traceparent, err := CreateTraceparent(trace.TraceID, trace.SpanID, trace.TraceFlags)
	if err != nil {
		return nil, err
	}
	cloned := request.Clone(ContextWithLogBrewTrace(request.Context(), trace))
	cloned.Header = request.Header.Clone()
	cloned.Header.Del("traceparent")
	cloned.Header.Set("traceparent", traceparent)
	return cloned, nil
}

func (t *httpClientTraceTransport) captureSpan(
	request *http.Request,
	trace TraceContext,
	response *http.Response,
	roundTripErr error,
	duration time.Duration,
	finished time.Time,
) {
	statusCode := 0
	if response != nil {
		statusCode = response.StatusCode
	}
	routeTemplate := t.routeTemplate(request)
	durationMs := float64(duration.Microseconds()) / 1000
	metadata := mergeMetadata(t.config.Metadata, t.spanMetadata(request, routeTemplate, trace, statusCode, roundTripErr))
	span, err := SpanAttributesFromTraceContext(TraceContextSpanInput{
		Trace:      trace,
		Name:       fmt.Sprintf("%s %s", strings.ToUpper(request.Method), routeTemplate),
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

func (t *httpClientTraceTransport) spanMetadata(
	request *http.Request,
	routeTemplate string,
	trace TraceContext,
	statusCode int,
	roundTripErr error,
) map[string]any {
	metadata := map[string]any{
		"source":        "net/http.client",
		"method":        strings.ToUpper(request.Method),
		"routeTemplate": routeTemplate,
		"sampled":       trace.Sampled,
	}
	if statusCode > 0 {
		metadata["statusCode"] = statusCode
	}
	if roundTripErr != nil {
		metadata["errorType"] = reflect.TypeOf(roundTripErr).String()
	}
	return metadata
}

func (t *httpClientTraceTransport) routeTemplate(request *http.Request) string {
	if t.config.RouteTemplate != "" {
		routeTemplate := sanitizeRouteTemplate(t.config.RouteTemplate)
		if routeTemplate != "" {
			return routeTemplate
		}
	}
	if request.URL != nil {
		routeTemplate := sanitizeRouteTemplate(request.URL.Path)
		if routeTemplate != "" {
			return routeTemplate
		}
	}
	return "/"
}

func (t *httpClientTraceTransport) eventID() string {
	return fmt.Sprintf("%s_span_%d", t.prefix, t.counter.Add(1))
}

func (t *httpClientTraceTransport) report(err error) {
	if err != nil && t.config.OnError != nil {
		t.config.OnError(err)
	}
}

func spanStatusFromHTTPClientResult(statusCode int, err error) string {
	if err != nil || statusCode >= 400 {
		return "error"
	}
	return "ok"
}
