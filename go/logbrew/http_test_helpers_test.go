package logbrew_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	logbrew "github.com/LogBrewCo/sdk/go/logbrew"
)

const (
	httpTestParentID    = "00f067aa0ba902b7"
	httpTestTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-a7ad6b7169203330-01"
	httpTestErrorStatus = "error"
	httpTestCancelled   = "cancelled"
	httpTestDeadline    = "deadline"
	httpTestWaitLimit   = 2 * time.Second
)

type httpTestEvent struct {
	Type       string             `json:"type"`
	Attributes httpTestAttributes `json:"attributes"`
}

type httpTestAttributes struct {
	Status       string           `json:"status"`
	TraceID      string           `json:"traceId"`
	SpanID       string           `json:"spanId"`
	ParentSpanID string           `json:"parentSpanId"`
	Metadata     httpTestMetadata `json:"metadata"`
}

type httpTestMetadata struct {
	ErrorType  string `json:"errorType"`
	Cancelled  bool   `json:"cancelled"`
	StatusCode int    `json:"statusCode"`
	Host       string `json:"host"`
}

func newHTTPTestClient(t *testing.T) *logbrew.Client {
	t.Helper()

	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:                "LOGBREW_API_KEY",
		SDKName:               "logbrew-go",
		SDKVersion:            "0.1.0",
		Context:               nil,
		DisableRuntimeContext: false,
		MaxRetries:            0,
		MaxQueueSize:          0,
		OnEventDropped:        nil,
	})
	if err != nil {
		t.Fatal(err)
	}

	return client
}

func newHTTPTestTransport(
	t *testing.T,
	client *logbrew.Client,
	base http.RoundTripper,
	finishBody bool,
) http.RoundTripper {
	t.Helper()

	transport, err := logbrew.NewHTTPClientTransport(logbrew.HTTPClientTransportConfig{
		Client:                        client,
		Base:                          base,
		RouteTemplate:                 "",
		EventIDPrefix:                 "",
		Metadata:                      nil,
		CapturePhaseTimings:           false,
		FinishSpanOnResponseBodyClose: finishBody,
		SpanIDFactory:                 nil,
		Now:                           nil,
		OnError:                       nil,
	})
	if err != nil {
		t.Fatal(err)
	}

	return transport
}

func newHTTPTestBase(t *testing.T) *http.Transport {
	t.Helper()

	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		t.Fatal("default transport does not support cloning")
	}

	cloned := base.Clone()
	t.Cleanup(cloned.CloseIdleConnections)

	return cloned
}

func newHTTPTestDoer(transport http.RoundTripper) *http.Client {
	return &http.Client{Transport: transport, CheckRedirect: nil, Jar: nil, Timeout: 0}
}

func newHTTPTestTrace(t *testing.T) logbrew.TraceContext {
	t.Helper()

	trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: httpTestTraceparent,
		SpanID:      httpTestParentID,
	})
	if err != nil {
		t.Fatal(err)
	}

	return trace
}

func newHTTPTestParentContext(t *testing.T) context.Context {
	t.Helper()

	return logbrew.ContextWithLogBrewTrace(t.Context(), newHTTPTestTrace(t))
}

func newHTTPTestRequest(ctx context.Context, t *testing.T, target string) *http.Request {
	t.Helper()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		t.Fatal(err)
	}

	return request
}

func doHTTPTestRequest(t *testing.T, client *http.Client, request *http.Request) *http.Response {
	t.Helper()

	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = response.Body.Close() })

	return response
}

func closeHTTPTestBody(t *testing.T, response *http.Response) {
	t.Helper()

	err := response.Body.Close()
	if err != nil {
		t.Fatalf("Close return changed: %v", err)
	}
}

func previewHTTPTestEvents(t *testing.T, client *logbrew.Client, count int) (string, []httpTestEvent) {
	t.Helper()

	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}

	var batch struct {
		Events []httpTestEvent `json:"events"`
	}

	err = json.Unmarshal([]byte(payload), &batch)
	if err != nil {
		t.Fatal(err)
	}

	if len(batch.Events) != count {
		t.Fatalf("expected %d events, got %d", count, len(batch.Events))
	}

	return payload, batch.Events
}

func assertHTTPTestPrivateMarkers(t *testing.T, payload string, markers ...string) {
	t.Helper()

	for _, marker := range markers {
		if strings.Contains(payload, marker) {
			t.Fatalf("private marker captured: %s", marker)
		}
	}
}

func assertHTTPTestPanic(t *testing.T, expected any, operation func()) {
	t.Helper()

	defer func() {
		if recovered := recover(); recovered != expected {
			t.Fatal("panic identity changed")
		}
	}()

	operation()
}

func waitHTTPTestSignal(t *testing.T, done <-chan struct{}) {
	t.Helper()

	select {
	case <-done:
	case <-time.After(httpTestWaitLimit):
		t.Fatal("HTTP operation did not finish")
	}
}

func newHTTPTestHandler(t *testing.T, client *logbrew.Client, next http.Handler, metric bool) http.Handler {
	t.Helper()

	handler, err := logbrew.NewHTTPHandler(next, logbrew.HTTPHandlerConfig{
		Client:               client,
		RouteTemplate:        "/operation",
		CaptureRequestMetric: metric,
		EventIDPrefix:        "",
		Metadata:             nil,
		SpanIDFactory:        nil,
		Now:                  nil,
		OnError:              nil,
	})
	if err != nil {
		t.Fatal(err)
	}

	return handler
}
