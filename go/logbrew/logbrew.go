// Package logbrew provides a small public client for building, validating,
// previewing, and flushing LogBrew event batches from Go applications.
package logbrew

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"
)

var (
	severityValues  = []string{"trace", "debug", "info", "warn", "warning", "error", "fatal", "critical"}
	severityAliases = map[string]string{
		"trace":    "info",
		"debug":    "info",
		"info":     "info",
		"warn":     "warning",
		"warning":  "warning",
		"error":    "error",
		"fatal":    "critical",
		"critical": "critical",
	}
	spanStatuses              = []string{"ok", "error"}
	actionStatus              = []string{"queued", "running", "success", "failure"}
	metricKinds               = []string{"counter", "gauge", "histogram"}
	metricTemporalitiesByKind = map[string][]string{
		"counter":   {"delta", "cumulative"},
		"gauge":     {"instant"},
		"histogram": {"delta", "cumulative"},
	}
	nonNegativeMetricKinds = []string{"counter", "histogram"}
)

const (
	// DefaultHTTPEndpoint is the production LogBrew event intake URL used by
	// NewHTTPTransport when no endpoint is supplied.
	DefaultHTTPEndpoint = "https://api.logbrew.com/v1/events"

	defaultHTTPTimeout = 10 * time.Second

	zeroTraceID = "00000000000000000000000000000000"
	zeroSpanID  = "0000000000000000"

	maxSpanLinks = 8
)

var defaultHTTPClient = &http.Client{Timeout: defaultHTTPTimeout}

// SdkError describes a stable public SDK failure with parseable code and
// message fields.
type SdkError struct {
	Code    string
	Message string
}

func (e *SdkError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// TransportError describes a transport-layer failure with a stable public code
// and retry hint.
type TransportError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *TransportError) Error() string {
	return e.Message
}

// NetworkError creates a retryable network failure that preserves queued
// events.
func NetworkError(message string) *TransportError {
	return &TransportError{Code: "network_failure", Message: message, Retryable: true}
}

// TransportResponse is returned after a transport accepts or skips a queued
// flush.
type TransportResponse struct {
	// StatusCode is the final HTTP-like status returned by the transport.
	StatusCode int `json:"status"`
	// Attempts is the number of transport attempts used for the flush.
	Attempts int `json:"attempts"`
}

// Transport is the public interface used by Flush and Shutdown transport calls.
type Transport interface {
	Send(apiKey string, body []byte) (*TransportResponse, error)
}

// RecordingTransport scripts transport outcomes for previewing, accepting, or
// failing queued event flushes in tests and local runs.
type RecordingTransport struct {
	scripted []any
	// SentBodies records every request body sent through this transport.
	SentBodies [][]byte
}

// NewRecordingTransport creates a scripted transport from public status codes
// or transport errors.
func NewRecordingTransport(scripted []any) *RecordingTransport {
	if len(scripted) == 0 {
		scripted = []any{202}
	}
	return &RecordingTransport{scripted: scripted, SentBodies: make([][]byte, 0)}
}

// AlwaysAcceptTransport creates a transport that accepts every queued flush
// request with a 202 response.
func AlwaysAcceptTransport() *RecordingTransport {
	return NewRecordingTransport([]any{202})
}

// LastBody returns the most recent request body sent through this transport.
func (t *RecordingTransport) LastBody() []byte {
	if len(t.SentBodies) == 0 {
		return nil
	}
	return t.SentBodies[len(t.SentBodies)-1]
}

func (t *RecordingTransport) Send(apiKey string, body []byte) (*TransportResponse, error) {
	if err := requireNonEmpty("api_key", apiKey); err != nil {
		return nil, err
	}
	t.SentBodies = append(t.SentBodies, append([]byte{}, body...))
	next := 202
	if len(t.scripted) > 0 {
		current := t.scripted[0]
		t.scripted = t.scripted[1:]
		switch value := current.(type) {
		case int:
			next = value
		case error:
			return nil, value
		default:
			return nil, &SdkError{Code: "transport_error", Message: "invalid scripted transport response"}
		}
	}
	return &TransportResponse{StatusCode: next, Attempts: 1}, nil
}

// HTTPTransportConfig configures the dependency-free HTTP transport.
type HTTPTransportConfig struct {
	// Endpoint is the URL that receives serialized LogBrew event batches.
	Endpoint string
	// Headers are added to every HTTP delivery request after default headers.
	Headers map[string]string
	// Client sends requests. When nil, Send uses a shared default client unless
	// Timeout asks NewHTTPTransport to create one.
	Client *http.Client
	// Timeout is used for the default HTTP client when Client is nil.
	Timeout time.Duration
}

// HTTPTransport sends queued batches through Go's standard net/http client.
type HTTPTransport struct {
	// Endpoint is the URL that receives serialized LogBrew event batches.
	Endpoint string
	// Headers are added to every HTTP delivery request after default headers.
	Headers map[string]string
	// Client sends requests. When nil, a shared default client is used.
	Client *http.Client
}

// NewHTTPTransport creates a dependency-free HTTP transport with safe defaults.
func NewHTTPTransport(config HTTPTransportConfig) (*HTTPTransport, error) {
	endpoint := config.Endpoint
	if strings.TrimSpace(endpoint) == "" {
		endpoint = DefaultHTTPEndpoint
	}
	if config.Timeout < 0 {
		return nil, &SdkError{Code: "configuration_error", Message: "HTTP transport timeout must be non-negative"}
	}
	headers, err := cloneHTTPHeaders(config.Headers)
	if err != nil {
		return nil, err
	}
	client := config.Client
	if client == nil && config.Timeout > 0 {
		client = &http.Client{Timeout: config.Timeout}
	}
	return &HTTPTransport{
		Endpoint: endpoint,
		Headers:  headers,
		Client:   client,
	}, nil
}

// Send posts one serialized event batch and returns the HTTP status.
func (t *HTTPTransport) Send(apiKey string, body []byte) (*TransportResponse, error) {
	if err := requireNonEmpty("api_key", apiKey); err != nil {
		return nil, err
	}
	endpoint := t.Endpoint
	if strings.TrimSpace(endpoint) == "" {
		endpoint = DefaultHTTPEndpoint
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &SdkError{Code: "configuration_error", Message: fmt.Sprintf("invalid HTTP transport endpoint: %v", err)}
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+apiKey)
	for name, value := range t.Headers {
		if strings.TrimSpace(name) == "" {
			return nil, &SdkError{Code: "configuration_error", Message: "HTTP transport header name must be non-empty"}
		}
		request.Header.Set(name, value)
	}
	client := t.Client
	if client == nil {
		client = defaultHTTPClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, NetworkError(fmt.Sprintf("http transport failed: %v", err))
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return &TransportResponse{StatusCode: response.StatusCode, Attempts: 1}, nil
}

// Config describes the public SDK identity, API key, and retry behavior for a
// Go LogBrew client.
type Config struct {
	// APIKey is the public LogBrew API key sent to the transport.
	APIKey string
	// SDKName identifies the calling SDK or application in emitted payloads.
	SDKName string
	// SDKVersion identifies the calling SDK or application version.
	SDKVersion string
	// MaxRetries sets the retry budget for retryable transport failures.
	MaxRetries int
}

type sdkInfo struct {
	Name     string `json:"name"`
	Language string `json:"language"`
	Version  string `json:"version"`
}

// Event is the public event shape buffered, previewed, and flushed by the
// client.
type Event struct {
	// Type is the stable LogBrew event type such as release or span.
	Type string `json:"type"`
	// Timestamp is the RFC 3339 event timestamp with timezone information.
	Timestamp string `json:"timestamp"`
	// ID is the caller-supplied stable identifier for the event.
	ID string `json:"id"`
	// Attributes contains the event payload fields for the given event type.
	Attributes map[string]any `json:"attributes"`
}

type eventBatch struct {
	SDK    sdkInfo `json:"sdk"`
	Events []Event `json:"events"`
}

// Client buffers validated LogBrew events until they are previewed, flushed,
// or shut down through a transport.
type Client struct {
	mu         sync.Mutex
	apiKey     string
	sdk        sdkInfo
	maxRetries int
	events     []Event
	closed     bool
}

// NewClient creates a public LogBrew client from user-supplied SDK identity
// and API key configuration.
func NewClient(config Config) (*Client, error) {
	if err := requireNonEmpty("api_key", config.APIKey); err != nil {
		return nil, err
	}
	if err := requireNonEmpty("sdk_name", config.SDKName); err != nil {
		return nil, err
	}
	if err := requireNonEmpty("sdk_version", config.SDKVersion); err != nil {
		return nil, err
	}
	maxRetries := config.MaxRetries
	if maxRetries == 0 {
		maxRetries = 2
	}
	return &Client{
		apiKey: config.APIKey,
		sdk: sdkInfo{
			Name:     config.SDKName,
			Language: "go",
			Version:  config.SDKVersion,
		},
		maxRetries: maxRetries,
		events:     make([]Event, 0),
	}, nil
}

// PendingEvents returns the number of validated events currently buffered in
// memory.
func (c *Client) PendingEvents() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.events)
}

// PreviewJSON returns the queued event batch as stable, pretty-printed JSON.
func (c *Client) PreviewJSON() (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.previewJSONLocked()
}

func (c *Client) previewJSONLocked() (string, error) {
	payload, err := json.MarshalIndent(eventBatch{SDK: c.sdk, Events: c.events}, "", "  ")
	if err != nil {
		return "", &SdkError{Code: "serialization_error", Message: err.Error()}
	}
	return string(payload), nil
}

// Flush sends queued events through a transport while preserving retry
// semantics.
func (c *Client) Flush(transport Transport) (*TransportResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	return c.flushInternalLocked(transport)
}

// Shutdown flushes queued events, then marks the client closed so later writes
// fail.
func (c *Client) Shutdown(transport Transport) (*TransportResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	response, err := c.flushInternalLocked(transport)
	if err != nil {
		return nil, err
	}
	c.closed = true
	return response, nil
}

// ReleaseAttributes describes the public payload fields for a release event.
type ReleaseAttributes struct {
	Version  string         `json:"version"`
	Commit   string         `json:"commit,omitempty"`
	Notes    string         `json:"notes,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// EnvironmentAttributes describes the public payload fields for an
// environment event.
type EnvironmentAttributes struct {
	Name     string         `json:"name"`
	Region   string         `json:"region,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// IssueAttributes describes the public payload fields for an issue event.
type IssueAttributes struct {
	Title    string         `json:"title"`
	Level    string         `json:"level"`
	Message  string         `json:"message,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// LogAttributes describes the public payload fields for a log event.
type LogAttributes struct {
	Message  string         `json:"message"`
	Level    string         `json:"level"`
	Logger   string         `json:"logger,omitempty"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// SpanAttributes describes the public payload fields for a span event.
type SpanAttributes struct {
	Name         string            `json:"name"`
	TraceID      string            `json:"traceId"`
	SpanID       string            `json:"spanId"`
	ParentSpanID string            `json:"parentSpanId,omitempty"`
	Status       string            `json:"status"`
	DurationMs   *float64          `json:"durationMs,omitempty"`
	Metadata     map[string]any    `json:"metadata,omitempty"`
	Links        []SpanLinkSummary `json:"links,omitempty"`
}

// SpanLinkSummary is a privacy-bounded link from one span to another W3C trace
// context, useful for queue batch/fan-in relationships.
type SpanLinkSummary struct {
	TraceID  string         `json:"traceId"`
	SpanID   string         `json:"spanId"`
	Sampled  bool           `json:"sampled"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// TraceparentContext describes an incoming W3C traceparent header after
// validation and normalization.
type TraceparentContext struct {
	// Version is the two-character W3C traceparent version.
	Version string
	// TraceID is the normalized 32-character trace identifier.
	TraceID string
	// ParentSpanID is the normalized 16-character upstream span identifier.
	ParentSpanID string
	// TraceFlags is the normalized two-character trace flags value.
	TraceFlags string
	// Sampled reports whether the W3C sampled flag is set.
	Sampled bool
}

// TraceparentSpanInput describes a LogBrew span derived from an incoming W3C
// traceparent header.
type TraceparentSpanInput struct {
	// Traceparent is the incoming W3C traceparent header value.
	Traceparent string
	// Name is the LogBrew span name.
	Name string
	// SpanID is the fresh child span identifier created by this service.
	SpanID string
	// Status is the LogBrew span status, usually ok or error.
	Status string
	// DurationMs is the optional span duration in milliseconds.
	DurationMs *float64
	// Metadata is copied with primitive values only.
	Metadata map[string]any
}

// ActionAttributes describes the public payload fields for an action event.
type ActionAttributes struct {
	Name     string         `json:"name"`
	Status   string         `json:"status"`
	Metadata map[string]any `json:"metadata,omitempty"`
}

// MetricAttributes describes the public payload fields for an explicit metric
// event.
type MetricAttributes struct {
	Name        string         `json:"name"`
	Kind        string         `json:"kind"`
	Value       float64        `json:"value"`
	Unit        string         `json:"unit"`
	Temporality string         `json:"temporality"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

func (c *Client) Release(id, timestamp string, attributes ReleaseAttributes) error {
	validated, err := validateRelease(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("release", id, timestamp, validated)
}

func (c *Client) Environment(id, timestamp string, attributes EnvironmentAttributes) error {
	validated, err := validateEnvironment(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("environment", id, timestamp, validated)
}

func (c *Client) Issue(id, timestamp string, attributes IssueAttributes) error {
	validated, err := validateIssue(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("issue", id, timestamp, validated)
}

func (c *Client) Log(id, timestamp string, attributes LogAttributes) error {
	validated, err := validateLog(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("log", id, timestamp, validated)
}

func (c *Client) Span(id, timestamp string, attributes SpanAttributes) error {
	validated, err := validateSpan(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("span", id, timestamp, validated)
}

func (c *Client) Action(id, timestamp string, attributes ActionAttributes) error {
	validated, err := validateAction(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("action", id, timestamp, validated)
}

// Metric queues an explicit, application-owned metric event after validating
// name, kind, value, unit, temporality, and optional metadata.
func (c *Client) Metric(id, timestamp string, attributes MetricAttributes) error {
	validated, err := validateMetric(attributes)
	if err != nil {
		return err
	}
	return c.pushEvent("metric", id, timestamp, validated)
}

func (c *Client) pushEvent(eventType, id, timestamp string, attributes map[string]any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return &SdkError{Code: "shutdown_error", Message: "client is already shut down"}
	}
	if err := requireNonEmpty("event id", id); err != nil {
		return err
	}
	if err := requireTimestamp(timestamp); err != nil {
		return err
	}
	c.events = append(c.events, Event{
		Type: eventType, ID: id, Timestamp: timestamp, Attributes: attributes,
	})
	return nil
}

func (c *Client) flushInternalLocked(transport Transport) (*TransportResponse, error) {
	if len(c.events) == 0 {
		return &TransportResponse{StatusCode: 204, Attempts: 0}, nil
	}
	body, err := c.previewJSONLocked()
	if err != nil {
		return nil, err
	}
	maxAttempts := c.maxRetries + 1
	for attempts := 1; attempts <= maxAttempts; attempts++ {
		response, sendErr := transport.Send(c.apiKey, []byte(body))
		if sendErr == nil {
			if response.StatusCode == 401 {
				return nil, &SdkError{Code: "unauthenticated", Message: "transport rejected the API key"}
			}
			if response.StatusCode >= 200 && response.StatusCode < 300 {
				c.events = c.events[:0]
				return &TransportResponse{StatusCode: response.StatusCode, Attempts: attempts}, nil
			}
			if response.StatusCode >= 500 && attempts < maxAttempts {
				continue
			}
			return nil, &SdkError{Code: "transport_error", Message: fmt.Sprintf("unexpected transport status %d", response.StatusCode)}
		}
		var transportErr *TransportError
		if ok := AsTransportError(sendErr, &transportErr); ok {
			if transportErr.Retryable && attempts < maxAttempts {
				continue
			}
			return nil, &SdkError{Code: transportErr.Code, Message: transportErr.Message}
		}
		return nil, sendErr
	}
	return nil, &SdkError{Code: "transport_error", Message: "exhausted retries"}
}

// AsTransportError extracts a public transport failure for retry-aware callers.
func AsTransportError(err error, target **TransportError) bool {
	typed, ok := err.(*TransportError)
	if ok {
		*target = typed
	}
	return ok
}

// ParseTraceparent validates and normalizes a W3C traceparent header.
func ParseTraceparent(traceparent string) (TraceparentContext, error) {
	parts := strings.Split(strings.TrimSpace(traceparent), "-")
	if len(parts) != 4 {
		return TraceparentContext{}, &SdkError{Code: "validation_error", Message: "traceparent must match W3C version-traceid-parentid-flags shape"}
	}
	version := strings.ToLower(parts[0])
	traceID := strings.ToLower(parts[1])
	parentSpanID := strings.ToLower(parts[2])
	traceFlags := strings.ToLower(parts[3])
	if len(version) != 2 || !isHex(version) {
		return TraceparentContext{}, &SdkError{Code: "validation_error", Message: "traceparent version must be two hex characters"}
	}
	if version == "ff" {
		return TraceparentContext{}, &SdkError{Code: "validation_error", Message: "traceparent version ff is forbidden"}
	}
	if err := requireTraceID(traceID); err != nil {
		return TraceparentContext{}, err
	}
	if err := requireSpanID("traceparent parent span id", parentSpanID); err != nil {
		return TraceparentContext{}, err
	}
	if err := requireTraceFlags(traceFlags); err != nil {
		return TraceparentContext{}, err
	}
	return TraceparentContext{
		Version:      version,
		TraceID:      traceID,
		ParentSpanID: parentSpanID,
		TraceFlags:   traceFlags,
		Sampled:      hexValue(traceFlags[1])&1 == 1,
	}, nil
}

// CreateTraceparent creates a normalized W3C traceparent header from explicit
// trace, span, and flags values. Empty traceFlags defaults to sampled "01".
func CreateTraceparent(traceID, spanID, traceFlags string) (string, error) {
	normalizedTraceID := strings.ToLower(strings.TrimSpace(traceID))
	normalizedSpanID := strings.ToLower(strings.TrimSpace(spanID))
	normalizedTraceFlags := strings.ToLower(strings.TrimSpace(traceFlags))
	if normalizedTraceFlags == "" {
		normalizedTraceFlags = "01"
	}
	if err := requireTraceID(normalizedTraceID); err != nil {
		return "", err
	}
	if err := requireSpanID("span id", normalizedSpanID); err != nil {
		return "", err
	}
	if err := requireTraceFlags(normalizedTraceFlags); err != nil {
		return "", err
	}
	return fmt.Sprintf("00-%s-%s-%s", normalizedTraceID, normalizedSpanID, normalizedTraceFlags), nil
}

// SpanAttributesFromTraceparent returns LogBrew span attributes that continue
// an incoming W3C traceparent as a child span.
func SpanAttributesFromTraceparent(input TraceparentSpanInput) (SpanAttributes, error) {
	context, err := ParseTraceparent(input.Traceparent)
	if err != nil {
		return SpanAttributes{}, err
	}
	spanID := strings.ToLower(strings.TrimSpace(input.SpanID))
	if err := requireNonEmpty("span name", input.Name); err != nil {
		return SpanAttributes{}, err
	}
	if err := requireSpanID("span id", spanID); err != nil {
		return SpanAttributes{}, err
	}
	if err := requireAllowedValue("span status", input.Status, spanStatuses); err != nil {
		return SpanAttributes{}, err
	}
	if input.DurationMs != nil && *input.DurationMs < 0 {
		return SpanAttributes{}, &SdkError{Code: "validation_error", Message: "span durationMs must be non-negative"}
	}
	return SpanAttributes{
		Name:         input.Name,
		TraceID:      context.TraceID,
		SpanID:       spanID,
		ParentSpanID: context.ParentSpanID,
		Status:       input.Status,
		DurationMs:   input.DurationMs,
		Metadata:     compactMetadata(input.Metadata),
	}, nil
}

// SpanLinkSummaryFromTraceparent validates a W3C traceparent value and returns
// a safe span-link summary without retaining the raw propagation string.
func SpanLinkSummaryFromTraceparent(traceparent string) (SpanLinkSummary, error) {
	context, err := ParseTraceparent(traceparent)
	if err != nil {
		return SpanLinkSummary{}, err
	}
	return SpanLinkSummary{
		TraceID: context.TraceID,
		SpanID:  context.ParentSpanID,
		Sampled: context.Sampled,
	}, nil
}

// NewSpanLinkSummary validates explicit W3C trace and span IDs and returns a
// safe span-link summary.
func NewSpanLinkSummary(traceID, spanID string, sampled bool) (SpanLinkSummary, error) {
	normalizedTraceID := strings.ToLower(strings.TrimSpace(traceID))
	normalizedSpanID := strings.ToLower(strings.TrimSpace(spanID))
	if err := requireTraceID(normalizedTraceID); err != nil {
		return SpanLinkSummary{}, err
	}
	if err := requireSpanID("span link span id", normalizedSpanID); err != nil {
		return SpanLinkSummary{}, err
	}
	return SpanLinkSummary{
		TraceID: normalizedTraceID,
		SpanID:  normalizedSpanID,
		Sampled: sampled,
	}, nil
}

func cloneHTTPHeaders(headers map[string]string) (map[string]string, error) {
	cloned := make(map[string]string, len(headers))
	for name, value := range headers {
		if strings.TrimSpace(name) == "" {
			return nil, &SdkError{Code: "configuration_error", Message: "HTTP transport header name must be non-empty"}
		}
		cloned[name] = value
	}
	return cloned, nil
}

func compactMetadata(metadata map[string]any) map[string]any {
	if metadata == nil {
		return nil
	}
	cloned := make(map[string]any)
	for key, value := range metadata {
		switch value.(type) {
		case string, bool, int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
			cloned[key] = value
		}
	}
	if len(cloned) == 0 {
		return nil
	}
	return cloned
}

func requireTraceID(value string) error {
	if len(value) != 32 || !isHex(value) {
		return &SdkError{Code: "validation_error", Message: "trace id must be 32 hex characters"}
	}
	if value == zeroTraceID {
		return &SdkError{Code: "validation_error", Message: "trace id must not be all zeros"}
	}
	return nil
}

func requireSpanID(label, value string) error {
	if len(value) != 16 || !isHex(value) {
		return &SdkError{Code: "validation_error", Message: fmt.Sprintf("%s must be 16 hex characters", label)}
	}
	if value == zeroSpanID {
		return &SdkError{Code: "validation_error", Message: fmt.Sprintf("%s must not be all zeros", label)}
	}
	return nil
}

func requireTraceFlags(value string) error {
	if len(value) != 2 || !isHex(value) {
		return &SdkError{Code: "validation_error", Message: "trace flags must be two hex characters"}
	}
	return nil
}

func isHex(value string) bool {
	for i := 0; i < len(value); i++ {
		if hexValue(value[i]) < 0 {
			return false
		}
	}
	return true
}

func hexValue(value byte) int {
	switch {
	case value >= '0' && value <= '9':
		return int(value - '0')
	case value >= 'a' && value <= 'f':
		return int(value-'a') + 10
	case value >= 'A' && value <= 'F':
		return int(value-'A') + 10
	default:
		return -1
	}
}

func requireNonEmpty(label, value string) error {
	if strings.TrimSpace(value) == "" {
		return &SdkError{Code: "validation_error", Message: fmt.Sprintf("%s must be non-empty", label)}
	}
	return nil
}

func requireAllowedValue(label, value string, allowed []string) error {
	if err := requireNonEmpty(label, value); err != nil {
		return err
	}
	if !slices.Contains(allowed, value) {
		return &SdkError{Code: "validation_error", Message: fmt.Sprintf("%s must be one of: %s", label, strings.Join(allowed, ", "))}
	}
	return nil
}

func normalizeSeverity(label, value string) (string, error) {
	if err := requireAllowedValue(label, value, severityValues); err != nil {
		return "", err
	}
	return severityAliases[value], nil
}

func requireTimestamp(timestamp string) error {
	if err := requireNonEmpty("timestamp", timestamp); err != nil {
		return err
	}
	if strings.HasSuffix(timestamp, "Z") {
		return nil
	}
	timeSplit := strings.Split(timestamp, "T")
	if len(timeSplit) < 2 {
		return &SdkError{Code: "validation_error", Message: fmt.Sprintf("timestamp must include a timezone offset: %s", timestamp)}
	}
	timePortion := timeSplit[1]
	if strings.Contains(timePortion, "+") {
		return nil
	}
	if index := strings.LastIndex(timePortion, "-"); index > 0 {
		return nil
	}
	return &SdkError{Code: "validation_error", Message: fmt.Sprintf("timestamp must include a timezone offset: %s", timestamp)}
}

func cloneMetadata(metadata map[string]any) map[string]any {
	if metadata == nil {
		return nil
	}
	cloned := make(map[string]any, len(metadata))
	for key, value := range metadata {
		cloned[key] = value
	}
	return cloned
}

func cloneSpanLinks(links []SpanLinkSummary) ([]map[string]any, error) {
	if len(links) == 0 {
		return nil, nil
	}
	if len(links) > maxSpanLinks {
		return nil, &SdkError{Code: "validation_error", Message: fmt.Sprintf("span links must contain at most %d entries", maxSpanLinks)}
	}
	cloned := make([]map[string]any, 0, len(links))
	for _, link := range links {
		normalizedTraceID := strings.ToLower(strings.TrimSpace(link.TraceID))
		normalizedSpanID := strings.ToLower(strings.TrimSpace(link.SpanID))
		if err := requireTraceID(normalizedTraceID); err != nil {
			return nil, err
		}
		if err := requireSpanID("span link span id", normalizedSpanID); err != nil {
			return nil, err
		}
		value := map[string]any{
			"traceId": normalizedTraceID,
			"spanId":  normalizedSpanID,
			"sampled": link.Sampled,
		}
		if metadata := compactMetadata(link.Metadata); metadata != nil {
			value["metadata"] = metadata
		}
		cloned = append(cloned, value)
	}
	return cloned, nil
}

func validateRelease(attributes ReleaseAttributes) (map[string]any, error) {
	if err := requireNonEmpty("release version", attributes.Version); err != nil {
		return nil, err
	}
	if attributes.Commit != "" {
		if err := requireNonEmpty("release commit", attributes.Commit); err != nil {
			return nil, err
		}
	}
	result := map[string]any{"version": attributes.Version}
	if attributes.Commit != "" {
		result["commit"] = attributes.Commit
	}
	if attributes.Notes != "" {
		result["notes"] = attributes.Notes
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}

func validateEnvironment(attributes EnvironmentAttributes) (map[string]any, error) {
	if err := requireNonEmpty("environment name", attributes.Name); err != nil {
		return nil, err
	}
	result := map[string]any{"name": attributes.Name}
	if attributes.Region != "" {
		result["region"] = attributes.Region
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}

func validateIssue(attributes IssueAttributes) (map[string]any, error) {
	if err := requireNonEmpty("issue title", attributes.Title); err != nil {
		return nil, err
	}
	level, err := normalizeSeverity("issue level", attributes.Level)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"title": attributes.Title, "level": level}
	if attributes.Message != "" {
		result["message"] = attributes.Message
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}

func validateLog(attributes LogAttributes) (map[string]any, error) {
	if err := requireNonEmpty("log message", attributes.Message); err != nil {
		return nil, err
	}
	level, err := normalizeSeverity("log level", attributes.Level)
	if err != nil {
		return nil, err
	}
	result := map[string]any{"message": attributes.Message, "level": level}
	if attributes.Logger != "" {
		result["logger"] = attributes.Logger
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}

func validateSpan(attributes SpanAttributes) (map[string]any, error) {
	if err := requireNonEmpty("span name", attributes.Name); err != nil {
		return nil, err
	}
	if err := requireNonEmpty("span traceId", attributes.TraceID); err != nil {
		return nil, err
	}
	if err := requireNonEmpty("span spanId", attributes.SpanID); err != nil {
		return nil, err
	}
	if err := requireAllowedValue("span status", attributes.Status, spanStatuses); err != nil {
		return nil, err
	}
	if attributes.ParentSpanID != "" {
		if err := requireNonEmpty("span parentSpanId", attributes.ParentSpanID); err != nil {
			return nil, err
		}
	}
	if attributes.DurationMs != nil && *attributes.DurationMs < 0 {
		return nil, &SdkError{Code: "validation_error", Message: "span durationMs must be non-negative"}
	}
	result := map[string]any{
		"name": attributes.Name, "traceId": attributes.TraceID, "spanId": attributes.SpanID, "status": attributes.Status,
	}
	if attributes.ParentSpanID != "" {
		result["parentSpanId"] = attributes.ParentSpanID
	}
	if attributes.DurationMs != nil {
		result["durationMs"] = *attributes.DurationMs
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	if links, err := cloneSpanLinks(attributes.Links); err != nil {
		return nil, err
	} else if links != nil {
		result["links"] = links
	}
	return result, nil
}

func validateAction(attributes ActionAttributes) (map[string]any, error) {
	if err := requireNonEmpty("action name", attributes.Name); err != nil {
		return nil, err
	}
	if err := requireAllowedValue("action status", attributes.Status, actionStatus); err != nil {
		return nil, err
	}
	result := map[string]any{"name": attributes.Name, "status": attributes.Status}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}

func validateMetric(attributes MetricAttributes) (map[string]any, error) {
	if err := requireNonEmpty("metric name", attributes.Name); err != nil {
		return nil, err
	}
	if err := requireAllowedValue("metric kind", attributes.Kind, metricKinds); err != nil {
		return nil, err
	}
	if math.IsNaN(attributes.Value) || math.IsInf(attributes.Value, 0) {
		return nil, &SdkError{Code: "validation_error", Message: "metric value must be a finite number"}
	}
	if err := requireNonEmpty("metric unit", attributes.Unit); err != nil {
		return nil, err
	}
	if err := requireAllowedValue(
		fmt.Sprintf("metric temporality for %s", attributes.Kind),
		attributes.Temporality,
		metricTemporalitiesByKind[attributes.Kind],
	); err != nil {
		return nil, err
	}
	if slices.Contains(nonNegativeMetricKinds, attributes.Kind) && attributes.Value < 0 {
		return nil, &SdkError{Code: "validation_error", Message: fmt.Sprintf("metric %s value must be non-negative", attributes.Kind)}
	}
	result := map[string]any{
		"name":        attributes.Name,
		"kind":        attributes.Kind,
		"value":       attributes.Value,
		"unit":        attributes.Unit,
		"temporality": attributes.Temporality,
	}
	if metadata := cloneMetadata(attributes.Metadata); metadata != nil {
		result["metadata"] = metadata
	}
	return result, nil
}
