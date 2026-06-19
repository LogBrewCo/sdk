package logbrew

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func sampleClient(t *testing.T) *Client {
	t.Helper()
	client, err := NewClient(Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "logbrew-go",
		SDKVersion: "0.1.0",
		MaxRetries: 2,
	})
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	return client
}

func enqueueAll(t *testing.T, client *Client) {
	t.Helper()
	if err := client.Release("evt_release_001", "2026-06-02T10:00:00Z", ReleaseAttributes{Version: "1.2.3", Commit: "abc123def456"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", EnvironmentAttributes{Name: "production", Region: "global"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes{Title: "Checkout timeout", Level: "error", Message: "Request timed out after retry budget"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes{Message: "worker started", Level: "info", Logger: "job-runner"}); err != nil {
		t.Fatal(err)
	}
	duration := 12.5
	if err := client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes{Name: "GET /health", TraceID: "trace_001", SpanID: "span_001", Status: "ok", DurationMs: &duration}); err != nil {
		t.Fatal(err)
	}
	if err := client.Action("evt_action_001", "2026-06-02T10:00:05Z", ActionAttributes{Name: "deploy", Status: "success"}); err != nil {
		t.Fatal(err)
	}
}

func runRepoCommand(t *testing.T, dir string, name string, args ...string) (string, string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		t.Fatalf("command %s %v failed: %v\nstderr:\n%s", name, args, err, stderr.String())
	}
	return stdout.String(), stderr.String()
}

func TestPreviewJSONContainsAllSupportedEventTypes(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	events := parsed["events"].([]any)
	eventTypes := make([]string, 0, len(events))
	for _, event := range events {
		eventTypes = append(eventTypes, event.(map[string]any)["type"].(string))
	}
	expected := []string{"release", "environment", "issue", "log", "span", "action"}
	for index := range expected {
		if eventTypes[index] != expected[index] {
			t.Fatalf("unexpected event type order: %#v", eventTypes)
		}
	}
}

func TestFlushSuccessClearsQueue(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)
	transport := AlwaysAcceptTransport()

	response, err := client.Flush(transport)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 202 || response.Attempts != 1 {
		t.Fatalf("unexpected response: %#v", response)
	}
	if client.PendingEvents() != 0 {
		t.Fatalf("expected queue to be empty, got %d", client.PendingEvents())
	}
	if !strings.Contains(string(transport.LastBody()), `"events"`) {
		t.Fatalf("expected events in body")
	}
}

func TestInvalidTimestampFailsValidation(t *testing.T) {
	client := sampleClient(t)
	err := client.Log("evt_log_001", "2026-06-02T10:00:03", LogAttributes{Message: "worker started", Level: "info"})
	if err == nil || !strings.Contains(err.Error(), "timestamp must include a timezone offset") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestInvalidIssueLevelFailsValidation(t *testing.T) {
	client := sampleClient(t)
	err := client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes{Title: "Checkout timeout", Level: "verbose"})
	if err == nil || !strings.Contains(err.Error(), "issue level must be one of: trace, debug, info, warn, warning, error, fatal, critical") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSeverityAliasesNormalizeBeforePreview(t *testing.T) {
	client := sampleClient(t)
	if err := client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", IssueAttributes{Title: "Checkout timeout", Level: "fatal"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes{Message: "verbose runtime detail", Level: "debug"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_log_002", "2026-06-02T10:00:04Z", LogAttributes{Message: "legacy warning alias", Level: "warn"}); err != nil {
		t.Fatal(err)
	}

	var payload struct {
		Events []struct {
			Attributes struct {
				Level string `json:"level"`
			} `json:"attributes"`
		} `json:"events"`
	}
	preview, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	got := []string{payload.Events[0].Attributes.Level, payload.Events[1].Attributes.Level, payload.Events[2].Attributes.Level}
	want := []string{"critical", "info", "warning"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("unexpected levels: got %v want %v", got, want)
	}
}

func TestNegativeSpanDurationFailsValidation(t *testing.T) {
	client := sampleClient(t)
	duration := -1.0
	err := client.Span("evt_span_001", "2026-06-02T10:00:04Z", SpanAttributes{Name: "GET /health", TraceID: "trace_001", SpanID: "span_001", Status: "ok", DurationMs: &duration})
	if err == nil || !strings.Contains(err.Error(), "span durationMs must be non-negative") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMetricEventValidatesExplicitContract(t *testing.T) {
	client := sampleClient(t)

	err := client.Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
		Name:        "queue.depth",
		Kind:        "gauge",
		Value:       -2,
		Unit:        "{items}",
		Temporality: "instant",
		Metadata:    map[string]any{"service": "worker", "queue": "critical"},
	})
	if err != nil {
		t.Fatal(err)
	}

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	events := parsed["events"].([]any)
	event := events[0].(map[string]any)
	attributes := event["attributes"].(map[string]any)
	if event["type"] != "metric" {
		t.Fatalf("unexpected event type: %#v", event["type"])
	}
	expected := map[string]any{
		"name":        "queue.depth",
		"kind":        "gauge",
		"value":       -2.0,
		"unit":        "{items}",
		"temporality": "instant",
	}
	for key, want := range expected {
		if attributes[key] != want {
			t.Fatalf("unexpected metric %s: got %#v want %#v", key, attributes[key], want)
		}
	}
	metadata := attributes["metadata"].(map[string]any)
	if metadata["service"] != "worker" || metadata["queue"] != "critical" {
		t.Fatalf("unexpected metric metadata: %#v", metadata)
	}
}

func TestMetricRejectsNonFiniteValue(t *testing.T) {
	client := sampleClient(t)
	err := client.Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
		Name:        "queue.depth",
		Kind:        "gauge",
		Value:       math.NaN(),
		Unit:        "{items}",
		Temporality: "instant",
	})
	if err == nil || !strings.Contains(err.Error(), "metric value must be a finite number") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMetricRejectsNegativeCounterValue(t *testing.T) {
	client := sampleClient(t)
	err := client.Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
		Name:        "jobs.completed",
		Kind:        "counter",
		Value:       -1,
		Unit:        "1",
		Temporality: "delta",
	})
	if err == nil || !strings.Contains(err.Error(), "metric counter value must be non-negative") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestMetricRejectsInvalidTemporalityForKind(t *testing.T) {
	client := sampleClient(t)
	err := client.Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
		Name:        "queue.depth",
		Kind:        "gauge",
		Value:       2,
		Unit:        "{items}",
		Temporality: "delta",
	})
	if err == nil || !strings.Contains(err.Error(), "metric temporality for gauge must be one of: instant") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestTraceparentHelpersParseCreateAndContinueW3CTraceContext(t *testing.T) {
	traceparent := "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-03"
	context, err := ParseTraceparent(traceparent)
	if err != nil {
		t.Fatal(err)
	}
	if context.Version != "00" {
		t.Fatalf("unexpected version: %s", context.Version)
	}
	if context.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" {
		t.Fatalf("unexpected trace id: %s", context.TraceID)
	}
	if context.ParentSpanID != "00f067aa0ba902b7" {
		t.Fatalf("unexpected parent span id: %s", context.ParentSpanID)
	}
	if context.TraceFlags != "03" {
		t.Fatalf("unexpected trace flags: %s", context.TraceFlags)
	}
	if !context.Sampled {
		t.Fatalf("expected sampled flag")
	}

	created, err := CreateTraceparent(
		"4BF92F3577B34DA6A3CE929D0E0E4736",
		"B7AD6B7169203331",
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if created != "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01" {
		t.Fatalf("unexpected created traceparent: %s", created)
	}

	duration := 8.5
	attributes, err := SpanAttributesFromTraceparent(TraceparentSpanInput{
		Traceparent: traceparent,
		Name:        "GET /health",
		SpanID:      "B7AD6B7169203331",
		Status:      "ok",
		DurationMs:  &duration,
		Metadata: map[string]any{
			"framework": "net/http",
			"status":    200,
			"sampled":   true,
			"nested":    map[string]any{"drop": true},
			"slice":     []string{"drop"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if attributes.TraceID != context.TraceID {
		t.Fatalf("unexpected span trace id: %s", attributes.TraceID)
	}
	if attributes.ParentSpanID != context.ParentSpanID {
		t.Fatalf("unexpected parent span id: %s", attributes.ParentSpanID)
	}
	if attributes.SpanID != "b7ad6b7169203331" {
		t.Fatalf("unexpected child span id: %s", attributes.SpanID)
	}
	if attributes.DurationMs == nil || *attributes.DurationMs != duration {
		t.Fatalf("unexpected duration: %#v", attributes.DurationMs)
	}
	if attributes.Metadata["framework"] != "net/http" ||
		attributes.Metadata["status"] != 200 ||
		attributes.Metadata["sampled"] != true {
		t.Fatalf("expected primitive metadata, got %#v", attributes.Metadata)
	}
	if _, ok := attributes.Metadata["nested"]; ok {
		t.Fatalf("expected nested metadata to be filtered: %#v", attributes.Metadata)
	}
	if _, ok := attributes.Metadata["slice"]; ok {
		t.Fatalf("expected slice metadata to be filtered: %#v", attributes.Metadata)
	}

	client := sampleClient(t)
	if err := client.Span("evt_traceparent_span", "2026-06-02T10:00:04Z", attributes); err != nil {
		t.Fatal(err)
	}
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(payload, `"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"`) ||
		!strings.Contains(payload, `"parentSpanId": "00f067aa0ba902b7"`) ||
		!strings.Contains(payload, `"spanId": "b7ad6b7169203331"`) {
		t.Fatalf("preview missing continued span attributes: %s", payload)
	}
}

func TestTraceparentHelpersRejectMalformedW3CTraceContext(t *testing.T) {
	invalidTraceparents := []string{
		"",
		"00-4bf92f3577b34da6a3ce929d0e0e4736",
		"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		"00-00000000000000000000000000000000-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
		"00-4bf92f3577b34da6a3ce929d0e0e473x-00f067aa0ba902b7-01",
		"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-0x",
	}
	for _, traceparent := range invalidTraceparents {
		t.Run(traceparent, func(t *testing.T) {
			if _, err := ParseTraceparent(traceparent); err == nil {
				t.Fatalf("expected parse failure for %q", traceparent)
			}
		})
	}

	if _, err := CreateTraceparent(zeroTraceID, "b7ad6b7169203331", "01"); err == nil {
		t.Fatalf("expected all-zero trace id to fail")
	}
	if _, err := CreateTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", zeroSpanID, "01"); err == nil {
		t.Fatalf("expected all-zero span id to fail")
	}
	if _, err := CreateTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "b7ad6b7169203331", "0x"); err == nil {
		t.Fatalf("expected malformed flags to fail")
	}
	if _, err := SpanAttributesFromTraceparent(TraceparentSpanInput{
		Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		Name:        "GET /health",
		SpanID:      zeroSpanID,
		Status:      "ok",
	}); err == nil {
		t.Fatalf("expected all-zero child span id to fail")
	}
}

func TestTimelineHelpersCreateSafeActionAttributes(t *testing.T) {
	statusCode := 503
	durationMs := 82.5

	action, err := CreateProductActionAttributes(ProductActionInput{
		Name:          "checkout.submit",
		Status:        "running",
		SessionID:     "sess_123",
		TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
		RouteTemplate: "https://app.example/checkout/:step?email=user@example.com#pay",
		Screen:        "Checkout",
		Funnel:        "checkout",
		Step:          "submit",
		Metadata: map[string]any{
			"service":       "checkout",
			"region":        "global",
			"ignoredObject": map[string]any{"nested": true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	network, err := CreateNetworkMilestoneAttributes(NetworkMilestoneInput{
		RouteTemplate: "https://api.example/v1/orders/:id?debug=true#trace",
		Method:        "post",
		StatusCode:    &statusCode,
		DurationMs:    &durationMs,
		SessionID:     "sess_123",
		TraceID:       "4bf92f3577b34da6a3ce929d0e0e4736",
		Metadata: map[string]any{
			"service":      "checkout",
			"region":       "global",
			"ignoredArray": []string{"ignored"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	expectedAction := ActionAttributes{
		Name:   "checkout.submit",
		Status: "running",
		Metadata: map[string]any{
			"source":        "product.action",
			"region":        "global",
			"service":       "checkout",
			"routeTemplate": "/checkout/:step",
			"sessionId":     "sess_123",
			"traceId":       "4bf92f3577b34da6a3ce929d0e0e4736",
			"screen":        "Checkout",
			"funnel":        "checkout",
			"step":          "submit",
		},
	}
	expectedNetwork := ActionAttributes{
		Name:   "network.post /v1/orders/:id",
		Status: "failure",
		Metadata: map[string]any{
			"source":        "network.milestone",
			"region":        "global",
			"service":       "checkout",
			"routeTemplate": "/v1/orders/:id",
			"method":        "POST",
			"statusCode":    503,
			"durationMs":    82.5,
			"sessionId":     "sess_123",
			"traceId":       "4bf92f3577b34da6a3ce929d0e0e4736",
		},
	}
	if !reflect.DeepEqual(action, expectedAction) {
		t.Fatalf("unexpected action attributes: got %#v want %#v", action, expectedAction)
	}
	if !reflect.DeepEqual(network, expectedNetwork) {
		t.Fatalf("unexpected network attributes: got %#v want %#v", network, expectedNetwork)
	}

	client := sampleClient(t)
	if err := client.Action("evt_checkout_submit", "2026-06-02T10:00:05Z", action); err != nil {
		t.Fatal(err)
	}
	if err := client.Action("evt_payment_api", "2026-06-02T10:00:06Z", network); err != nil {
		t.Fatal(err)
	}
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "email=user@example.com") ||
		strings.Contains(payload, "debug=true") ||
		strings.Contains(payload, "ignoredObject") ||
		strings.Contains(payload, "ignoredArray") {
		t.Fatalf("preview leaked unsafe timeline metadata: %s", payload)
	}
}

func TestTimelineHelpersRejectUnsafeMilestoneValues(t *testing.T) {
	invalidStatusCode := 99
	negativeDuration := -1.0
	cases := []struct {
		name    string
		run     func() error
		message string
	}{
		{
			name: "invalid product action status",
			run: func() error {
				_, err := CreateProductActionAttributes(ProductActionInput{Name: "checkout.submit", Status: "done"})
				return err
			},
			message: "product action status must be one of: queued, running, success, failure",
		},
		{
			name: "invalid network method",
			run: func() error {
				_, err := CreateNetworkMilestoneAttributes(NetworkMilestoneInput{RouteTemplate: "/orders/:id", Method: "GET /bad"})
				return err
			},
			message: "network milestone method must be a valid HTTP method",
		},
		{
			name: "invalid network duration",
			run: func() error {
				_, err := CreateNetworkMilestoneAttributes(NetworkMilestoneInput{RouteTemplate: "/orders/:id", DurationMs: &negativeDuration})
				return err
			},
			message: "network milestone durationMs must be a non-negative number",
		},
		{
			name: "invalid network status code",
			run: func() error {
				_, err := CreateNetworkMilestoneAttributes(NetworkMilestoneInput{RouteTemplate: "/orders/:id", StatusCode: &invalidStatusCode})
				return err
			},
			message: "network milestone statusCode must be an integer from 100 to 599",
		},
	}

	for _, current := range cases {
		t.Run(current.name, func(t *testing.T) {
			err := current.run()
			if err == nil || !strings.Contains(err.Error(), current.message) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestUnauthenticatedResponseSurfacesCleanError(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)
	transport := NewRecordingTransport([]any{401})
	_, err := client.Flush(transport)
	if err == nil || !strings.Contains(err.Error(), "transport rejected the API key") {
		t.Fatalf("unexpected error: %v", err)
	}
	if client.PendingEvents() != 6 {
		t.Fatalf("expected queue to stay full")
	}
}

func TestNetworkFailureRetriesBeforeSucceeding(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)
	transport := NewRecordingTransport([]any{NetworkError("temporary outage"), 202})
	response, err := client.Flush(transport)
	if err != nil {
		t.Fatal(err)
	}
	if response.Attempts != 2 {
		t.Fatalf("expected 2 attempts, got %d", response.Attempts)
	}
	if len(transport.SentBodies) != 2 {
		t.Fatalf("expected 2 sent bodies, got %d", len(transport.SentBodies))
	}
}

func TestHTTPTransportPostsJSONAndMapsStatus(t *testing.T) {
	var method string
	var path string
	var body string
	var contentType string
	var authorization string
	var source string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		method = request.Method
		path = request.URL.Path
		contentType = request.Header.Get("content-type")
		authorization = request.Header.Get("authorization")
		source = request.Header.Get("x-logbrew-source")
		data, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		body = string(data)
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	transport, err := NewHTTPTransport(HTTPTransportConfig{
		Endpoint: server.URL + "/v1/events",
		Headers:  map[string]string{"x-logbrew-source": "go-unit"},
		Client:   server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := transport.Send("LOGBREW_API_KEY", []byte(`{"events":[]}`))
	if err != nil {
		t.Fatal(err)
	}

	if result.StatusCode != http.StatusAccepted || result.Attempts != 1 {
		t.Fatalf("unexpected transport response: %#v", result)
	}
	if method != http.MethodPost {
		t.Fatalf("unexpected method: %s", method)
	}
	if path != "/v1/events" {
		t.Fatalf("unexpected path: %s", path)
	}
	if body != `{"events":[]}` {
		t.Fatalf("unexpected body: %s", body)
	}
	if contentType != "application/json" {
		t.Fatalf("unexpected content type: %s", contentType)
	}
	if authorization != "Bearer LOGBREW_API_KEY" {
		t.Fatalf("unexpected authorization header: %s", authorization)
	}
	if source != "go-unit" {
		t.Fatalf("unexpected source header: %s", source)
	}
}

func TestHTTPTransportStatusRetriesThroughClient(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		attempts++
		if attempts == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		response.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	client, err := NewClient(Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "logbrew-go",
		SDKVersion: "0.1.0",
		MaxRetries: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_go_http_transport", "2026-06-02T10:00:06Z", LogAttributes{Message: "delivery retry", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	transport, err := NewHTTPTransport(HTTPTransportConfig{
		Endpoint: server.URL + "/v1/events",
		Client:   server.Client(),
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Flush(transport)
	if err != nil {
		t.Fatal(err)
	}

	if response.StatusCode != http.StatusAccepted || response.Attempts != 2 {
		t.Fatalf("unexpected response: %#v", response)
	}
	if attempts != 2 {
		t.Fatalf("expected two HTTP attempts, got %d", attempts)
	}
	if client.PendingEvents() != 0 {
		t.Fatalf("expected queue to be empty, got %d", client.PendingEvents())
	}
}

func TestHTTPTransportNetworkErrorIsRetryable(t *testing.T) {
	transport, err := NewHTTPTransport(HTTPTransportConfig{
		Endpoint: "http://127.0.0.1/v1/events",
		Client: &http.Client{
			Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
				return nil, errors.New("offline")
			}),
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, sendErr := transport.Send("LOGBREW_API_KEY", []byte(`{"events":[]}`))
	var transportErr *TransportError
	if ok := AsTransportError(sendErr, &transportErr); !ok {
		t.Fatalf("expected transport error, got %v", sendErr)
	}
	if transportErr.Code != "network_failure" || !transportErr.Retryable {
		t.Fatalf("unexpected transport error: %#v", transportErr)
	}
	if !strings.Contains(transportErr.Message, "http transport failed") {
		t.Fatalf("unexpected message: %s", transportErr.Message)
	}
}

func TestShutdownFlushesAndPreventsFutureEvents(t *testing.T) {
	client := sampleClient(t)
	enqueueAll(t, client)
	transport := AlwaysAcceptTransport()
	if _, err := client.Shutdown(transport); err != nil {
		t.Fatal(err)
	}
	err := client.Action("evt_action_002", "2026-06-02T10:00:06Z", ActionAttributes{Name: "deploy", Status: "success"})
	if err == nil || !strings.Contains(err.Error(), "client is already shut down") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestRepoCheckoutReadmeExampleRunsDirectly(t *testing.T) {
	stdout, stderr := runRepoCommand(t, ".", "go", "run", "./examples/readme_example")
	if !strings.Contains(stdout, `"type": "release"`) ||
		!strings.Contains(stdout, `"type": "environment"`) ||
		!strings.Contains(stdout, `"type": "issue"`) ||
		!strings.Contains(stdout, `"type": "log"`) ||
		!strings.Contains(stdout, `"type": "span"`) ||
		!strings.Contains(stdout, `"type": "action"`) {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutRealUserSmokeRunsDirectly(t *testing.T) {
	stdout, stderr := runRepoCommand(t, ".", "go", "run", "./examples/real_user_smoke")
	if !strings.Contains(stdout, `"type": "release"`) ||
		!strings.Contains(stdout, `"type": "environment"`) ||
		!strings.Contains(stdout, `"type": "issue"`) ||
		!strings.Contains(stdout, `"type": "log"`) ||
		!strings.Contains(stdout, `"type": "span"`) ||
		!strings.Contains(stdout, `"type": "action"`) {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeListsCommands(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make")
	if stderr != "" {
		t.Fatalf("expected empty stderr, got %q", stderr)
	}
	expectedInOrder := []string{
		"run-agent-timeline -> make run-agent-timeline",
		"run-first-useful-telemetry -> make run-first-useful-telemetry",
		"run-http-client-trace -> make run-http-client-trace",
		"run-http-trace-correlation -> make run-http-trace-correlation",
		"run-readme-example -> make run-readme-example",
		"run (real-user-smoke) -> make run",
		"run-real-user-smoke -> make run-real-user-smoke",
	}
	lines := strings.Split(strings.TrimSpace(stdout), "\n")
	if len(lines) < len(expectedInOrder) {
		t.Fatalf("unexpected make output: %q", stdout)
	}
	next := 0
	for _, line := range lines {
		if next < len(expectedInOrder) && line == expectedInOrder[next] {
			next++
		}
	}
	if next != len(expectedInOrder) {
		t.Fatalf("make output missing required ordered commands: %q", stdout)
	}
}

func TestRepoCheckoutExamplesMakeRunAgentTimelineExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-agent-timeline")
	if !strings.Contains(stdout, `"source": "product.action"`) ||
		!strings.Contains(stdout, `"source": "network.milestone"`) ||
		!strings.Contains(stdout, `"routeTemplate": "/checkout/:step"`) ||
		!strings.Contains(stdout, `"routeTemplate": "/v1/payments/:id"`) ||
		!strings.Contains(stdout, "00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01") {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if strings.Contains(stdout, "email=user@example.com") ||
		strings.Contains(stdout, "debug=true") ||
		strings.Contains(stdout, "payload") ||
		strings.Contains(stdout, "headers") {
		t.Fatalf("agent timeline leaked unsafe data: %s", stdout)
	}
	if stderr != "" {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunFirstUsefulTelemetryExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-first-useful-telemetry")
	for _, needle := range []string{
		`"type": "release"`,
		`"type": "environment"`,
		`"type": "log"`,
		`"type": "action"`,
		`"type": "metric"`,
		`"type": "span"`,
		`"name": "http.server.duration"`,
		`"routeTemplate": "/checkout/:cart_id"`,
		`"routeTemplate": "/payments/:payment_id"`,
		`"parentSpanId": "00f067aa0ba902b7"`,
		`"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"`,
	} {
		if !strings.Contains(stdout, needle) {
			t.Fatalf("first-useful example missing %q in stdout: %s", needle, stdout)
		}
	}
	for _, unsafe := range []string{
		"coupon=private",
		"card=private",
		"authorization",
		"payload",
		"headers",
		"#authorize",
		"?",
	} {
		if strings.Contains(stdout, unsafe) {
			t.Fatalf("first-useful example leaked unsafe value %q: %s", unsafe, stdout)
		}
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":7`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunHTTPTraceCorrelationExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-http-trace-correlation")
	for _, needle := range []string{
		`"type": "release"`,
		`"type": "environment"`,
		`"type": "log"`,
		`"type": "issue"`,
		`"type": "span"`,
		`"type": "metric"`,
		`"name": "http.server.duration"`,
		`"routeTemplate": "/checkout/:cart_id"`,
		`"parentSpanId": "00f067aa0ba902b7"`,
		`"spanId": "b7ad6b7169203331"`,
		`"traceId": "4bf92f3577b34da6a3ce929d0e0e4736"`,
		`"source": "slog"`,
	} {
		if !strings.Contains(stdout, needle) {
			t.Fatalf("HTTP trace example missing %q in stdout: %s", needle, stdout)
		}
	}
	for _, unsafe := range []string{
		"coupon=sale",
		"card",
		"payload",
		"#confirm",
		"?",
	} {
		if strings.Contains(stdout, unsafe) {
			t.Fatalf("HTTP trace example leaked unsafe value %q: %s", unsafe, stdout)
		}
	}
	if !strings.Contains(stderr, `"appLogHasTrace":true`) ||
		!strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"`) ||
		!strings.Contains(stderr, `"requestStatus":502`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunExecutesSmoke(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run")
	if !strings.Contains(stdout, `"type": "release"`) ||
		!strings.Contains(stdout, `"type": "environment"`) ||
		!strings.Contains(stdout, `"type": "issue"`) ||
		!strings.Contains(stdout, `"type": "log"`) ||
		!strings.Contains(stdout, `"type": "span"`) ||
		!strings.Contains(stdout, `"type": "action"`) {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunReadmeExampleExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-readme-example")
	if !strings.Contains(stdout, `"type": "release"`) ||
		!strings.Contains(stdout, `"type": "environment"`) ||
		!strings.Contains(stdout, `"type": "issue"`) ||
		!strings.Contains(stdout, `"type": "log"`) ||
		!strings.Contains(stdout, `"type": "span"`) ||
		!strings.Contains(stdout, `"type": "action"`) {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunRealUserSmokeExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-real-user-smoke")
	if !strings.Contains(stdout, `"type": "release"`) ||
		!strings.Contains(stdout, `"type": "environment"`) ||
		!strings.Contains(stdout, `"type": "issue"`) ||
		!strings.Contains(stdout, `"type": "log"`) ||
		!strings.Contains(stdout, `"type": "span"`) ||
		!strings.Contains(stdout, `"type": "action"`) {
		t.Fatalf("unexpected stdout: %s", stdout)
	}
	if !strings.Contains(stderr, `"attempts":1`) ||
		!strings.Contains(stderr, `"events":6`) ||
		!strings.Contains(stderr, `"ok":true`) ||
		!strings.Contains(stderr, `"status":202`) {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}
