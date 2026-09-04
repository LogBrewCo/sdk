package logbrew

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"
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

func testTrace(t *testing.T, spanID string) TraceContext {
	t.Helper()
	trace, err := NewTraceContext(TraceContextInput{Traceparent: "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01", SpanID: spanID})
	if err != nil {
		t.Fatal(err)
	}
	return trace
}

func testNow(after time.Duration) func() time.Time {
	base := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	first := true
	return func() time.Time {
		if first {
			first = false
			return base
		}
		return base.Add(after)
	}
}

type testPreviewEvent struct {
	Type       string         `json:"type"`
	ID         string         `json:"id"`
	Attributes map[string]any `json:"attributes"`
}

func previewEvents(t *testing.T, client *Client) (string, []testPreviewEvent) {
	t.Helper()
	payload := previewPayload(t, client)
	var parsed struct {
		Events []testPreviewEvent `json:"events"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		t.Fatal(err)
	}
	return payload, parsed.Events
}

func previewEvent(t *testing.T, client *Client) (string, testPreviewEvent) {
	t.Helper()
	payload, events := previewEvents(t, client)
	if len(events) != 1 {
		t.Fatalf("unexpected event count %d: %s", len(events), payload)
	}
	return payload, events[0]
}

func previewPayload(t *testing.T, client *Client) string {
	t.Helper()
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func assertText(t *testing.T, payload string, required, forbidden []string) {
	t.Helper()
	for _, value := range required {
		if !strings.Contains(payload, value) {
			t.Fatalf("payload missing %q: %s", value, payload)
		}
	}
	for _, value := range forbidden {
		if strings.Contains(payload, value) {
			t.Fatalf("payload exposed %q: %s", value, payload)
		}
	}
}

func assertSixEventExample(t *testing.T, stdout, stderr string) {
	t.Helper()
	assertText(t, stdout, []string{`"type": "release"`, `"type": "environment"`, `"type": "issue"`, `"type": "log"`, `"type": "span"`, `"type": "action"`}, nil)
	assertText(t, stderr, []string{`"attempts":1`, `"events":6`, `"ok":true`, `"status":202`}, nil)
}

func capturePanic(operation func()) (recovered any) {
	defer func() {
		recovered = recover()
	}()
	operation()
	return nil
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

	_, events := previewEvents(t, client)
	eventTypes := make([]string, 0, len(events))
	for _, event := range events {
		eventTypes = append(eventTypes, event.Type)
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

func TestBoundedQueueDropsNewEventsAndReportsAdvisory(t *testing.T) {
	drops := make([]EventDrop, 0)
	client, err := NewClient(Config{
		APIKey:         "LOGBREW_API_KEY",
		SDKName:        "logbrew-go",
		SDKVersion:     "0.1.0",
		MaxQueueSize:   2,
		OnEventDropped: func(drop EventDrop) { drops = append(drops, drop) },
	})
	if err != nil {
		t.Fatal(err)
	}

	for index, id := range []string{"evt_log_001", "evt_log_002", "evt_log_003"} {
		if err := client.Log(id, "2026-06-02T10:00:03Z", LogAttributes{Message: "high volume log", Level: "info"}); err != nil {
			t.Fatalf("log %d failed: %v", index, err)
		}
	}

	if client.PendingEvents() != 2 {
		t.Fatalf("expected bounded queue to keep 2 events, got %d", client.PendingEvents())
	}
	if client.DroppedEvents() != 1 {
		t.Fatalf("expected one dropped event, got %d", client.DroppedEvents())
	}
	if len(drops) != 1 {
		t.Fatalf("expected one advisory drop, got %#v", drops)
	}
	if drops[0].EventID != "evt_log_003" || drops[0].EventType != "log" || drops[0].Reason != "queue_overflow" || drops[0].DroppedEvents != 1 {
		t.Fatalf("unexpected drop advisory: %#v", drops[0])
	}

	transport := AlwaysAcceptTransport()
	response, err := client.Flush(transport)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 202 || response.Attempts != 1 {
		t.Fatalf("unexpected response: %#v", response)
	}
	body := string(transport.LastBody())
	if !strings.Contains(body, "evt_log_001") || !strings.Contains(body, "evt_log_002") {
		t.Fatalf("expected first two events in body: %s", body)
	}
	if strings.Contains(body, "evt_log_003") {
		t.Fatalf("dropped event leaked into body: %s", body)
	}
}

func TestEventDropAdvisoryCannotInterruptCapture(t *testing.T) {
	client, err := NewClient(Config{
		APIKey:       "LOGBREW_API_KEY",
		SDKName:      "logbrew-go",
		SDKVersion:   "0.1.0",
		MaxQueueSize: 1,
		OnEventDropped: func(EventDrop) {
			panic("advisory failure should not interrupt app logging")
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if err := client.Log("evt_log_001", "2026-06-02T10:00:03Z", LogAttributes{Message: "kept", Level: "info"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Log("evt_log_002", "2026-06-02T10:00:04Z", LogAttributes{Message: "dropped", Level: "info"}); err != nil {
		t.Fatalf("drop advisory interrupted capture: %v", err)
	}
	if client.PendingEvents() != 1 || client.DroppedEvents() != 1 {
		t.Fatalf("unexpected queue state pending=%d dropped=%d", client.PendingEvents(), client.DroppedEvents())
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
	preview := previewPayload(t, client)
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	got := []string{payload.Events[0].Attributes.Level, payload.Events[1].Attributes.Level, payload.Events[2].Attributes.Level}
	want := []string{"critical", "info", "warning"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("unexpected levels: got %v want %v", got, want)
	}
}

func TestIssueDiagnosticsAreValidatedDetachedAndNormalized(t *testing.T) {
	client := sampleClient(t)
	attributes := IssueAttributes{
		Title:   "Checkout failed",
		Level:   "error",
		Message: "A safe application-owned summary",
		Exception: &IssueException{
			Type: "CheckoutError",
			Mechanism: &IssueExceptionMechanism{
				Type:    "go.recover",
				Handled: true,
			},
		},
		StackFrames: []IssueStackFrame{{
			Filename: `C:\workspace\checkout.go`,
			Line:     42,
			Column:   1,
			Function: "submitOrder",
			Module:   "example.com/store/checkout",
			InApp:    boolPtr(true),
			DebugID:  "A5B8F2C1-7D3E-4A10-9C42-112233445566",
		}},
		Breadcrumbs: []IssueBreadcrumb{{
			Timestamp: "2026-08-02T08:15:30.123Z",
			Type:      "http",
			Category:  "checkout.request",
			Level:     "warn",
			Message:   "Inventory request completed",
			Data: map[string]any{
				"attempt":     2,
				"cache_hit":   false,
				"status_code": 503,
			},
		}},
		BreadcrumbsTruncated: true,
	}
	if err := client.Issue("evt_issue_diagnostics", "2026-08-02T08:15:31Z", attributes); err != nil {
		t.Fatal(err)
	}

	attributes.Exception.Type = "MutatedError"
	attributes.Exception.Mechanism.Type = "mutated"
	attributes.StackFrames[0].Filename = "mutated.go"
	attributes.StackFrames[0].InApp = boolPtr(false)
	attributes.Breadcrumbs[0].Data["attempt"] = 99

	var payload struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	preview := previewPayload(t, client)
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	queued := payload.Events[0].Attributes
	exception := queued["exception"].(map[string]any)
	mechanism := exception["mechanism"].(map[string]any)
	frames := queued["stackFrames"].([]any)
	frame := frames[0].(map[string]any)
	breadcrumbs := queued["breadcrumbs"].([]any)
	breadcrumb := breadcrumbs[0].(map[string]any)
	data := breadcrumb["data"].(map[string]any)
	if exception["type"] != "CheckoutError" || mechanism["type"] != "go.recover" || mechanism["handled"] != true {
		t.Fatalf("unexpected exception diagnostics: %#v", exception)
	}
	if frame["filename"] != "checkout.go" || frame["function"] != "submitOrder" ||
		frame["module"] != "example.com/store/checkout" || frame["inApp"] != true ||
		frame["debugId"] != "a5b8f2c1-7d3e-4a10-9c42-112233445566" {
		t.Fatalf("unexpected stack frame: %#v", frame)
	}
	if breadcrumb["level"] != "warning" || data["attempt"] != float64(2) || queued["breadcrumbsTruncated"] != true {
		t.Fatalf("unexpected breadcrumb diagnostics: %#v", queued)
	}
}

func TestIssueDiagnosticEvidenceIsValidatedAndDetached(t *testing.T) {
	inApp := true
	evidence := &IssueDiagnosticEvidence{
		LikelyRootCause: "The payment provider exhausted its retry budget.",
		LikelyFixArea: &IssueLikelyFixArea{
			Component: "checkout-api",
			Module:    "payments.gateway",
			Function:  "chargeOrder",
			File:      "internal/payments/gateway.go",
			Line:      42,
			Column:    7,
			InApp:     &inApp,
		},
		Impact: &IssueImpactEvidence{
			AffectedUserSegment: "checkout-users",
			FailedAction:        "checkout.submit",
			UserVisibleOutcome:  "The order was not confirmed.",
		},
		CapturedFields:  []string{"provider.status", "retry.count"},
		MissingFields:   []string{"provider.request_id"},
		RedactedFields:  []string{"provider.message"},
		TruncatedFields: []string{"breadcrumbs"},
	}
	client := sampleClient(t)
	if err := client.Issue("evt_issue_evidence", "2026-08-02T08:15:31Z", IssueAttributes{
		Title: "Checkout failed", Level: "error", Evidence: evidence,
	}); err != nil {
		t.Fatal(err)
	}
	evidence.LikelyFixArea.File = "mutated.go"
	evidence.CapturedFields = append(evidence.CapturedFields, "mutated")

	preview := previewPayload(t, client)
	var payload struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	queued := payload.Events[0].Attributes["evidence"].(map[string]any)
	fixArea := queued["likelyFixArea"].(map[string]any)
	impact := queued["impact"].(map[string]any)
	captured := queued["capturedFields"].([]any)
	if queued["likelyRootCause"] != "The payment provider exhausted its retry budget." ||
		fixArea["component"] != "checkout-api" || fixArea["module"] != "payments.gateway" ||
		fixArea["function"] != "chargeOrder" || fixArea["file"] != "internal/payments/gateway.go" ||
		fixArea["line"] != float64(42) || fixArea["column"] != float64(7) || fixArea["inApp"] != true ||
		impact["affectedUserSegment"] != "checkout-users" || impact["failedAction"] != "checkout.submit" ||
		impact["userVisibleOutcome"] != "The order was not confirmed." ||
		len(captured) != 2 || captured[1] != "retry.count" ||
		!reflect.DeepEqual(queued["missingFields"], []any{"provider.request_id"}) ||
		!reflect.DeepEqual(queued["redactedFields"], []any{"provider.message"}) ||
		!reflect.DeepEqual(queued["truncatedFields"], []any{"breadcrumbs"}) {
		t.Fatalf("unexpected diagnostic evidence: %#v", queued)
	}
}

func TestIssueAttributesFromErrorPreservesUnwrapEvidenceWithoutErrorText(t *testing.T) {
	cause := errors.New("private cause message")
	wrapped := fmt.Errorf("private wrapper message: %w", cause)
	attributes, err := IssueAttributesFromError(wrapped, "Checkout failed", "go.error", true)
	if err != nil {
		t.Fatal(err)
	}
	client := sampleClient(t)
	if err := client.Issue("evt_issue_error_chain", "2026-08-02T08:15:31Z", attributes); err != nil {
		t.Fatal(err)
	}
	preview := previewPayload(t, client)
	for _, privateValue := range []string{"private cause message", "private wrapper message"} {
		if strings.Contains(preview, privateValue) {
			t.Fatalf("error chain leaked %q: %s", privateValue, preview)
		}
	}
	var payload struct {
		Events []struct {
			Attributes map[string]any `json:"attributes"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(preview), &payload); err != nil {
		t.Fatal(err)
	}
	queued := payload.Events[0].Attributes
	exception := queued["exception"].(map[string]any)
	if exception["type"] != "*fmt.wrapError" {
		t.Fatalf("reported error type missing: %#v", exception)
	}
	chain := queued["exceptionChain"].(map[string]any)
	entries := chain["entries"].([]any)
	if len(entries) != 2 || chain["truncated"] != false {
		t.Fatalf("unexpected error chain: %#v", chain)
	}
	reported := entries[0].(map[string]any)
	underlying := entries[1].(map[string]any)
	if reported["relationship"] != "reported" || reported["messageState"] != "redacted" ||
		reported["stackFramesState"] != "captured" || reported["type"] != exception["type"] {
		t.Fatalf("reported error evidence missing: %#v", reported)
	}
	if underlying["parentId"] != float64(0) || underlying["relationship"] != "cause" ||
		underlying["type"] != "*errors.errorString" || underlying["messageState"] != "redacted" ||
		underlying["stackFramesState"] != "not_captured" || underlying["stackFrames"] != nil {
		t.Fatalf("underlying error evidence missing: %#v", underlying)
	}
	if !reflect.DeepEqual(reported["stackFrames"], queued["stackFrames"]) {
		t.Fatalf("reported stack does not match legacy stack: %#v", queued)
	}

	joined := errors.Join(errors.New("private first member"), errors.New("private second member"))
	joinedAttributes, err := IssueAttributesFromError(joined, "Batch failed", "go.error", true)
	if err != nil {
		t.Fatal(err)
	}
	joinedClient := sampleClient(t)
	if err := joinedClient.Issue("evt_issue_joined_chain", "2026-08-02T08:15:31Z", joinedAttributes); err != nil {
		t.Fatal(err)
	}
	joinedPreview := previewPayload(t, joinedClient)
	if strings.Count(joinedPreview, `"relationship": "aggregate_member"`) != 2 ||
		strings.Contains(joinedPreview, "private first member") || strings.Contains(joinedPreview, "private second member") {
		t.Fatalf("joined error evidence is incomplete or unsafe: %s", joinedPreview)
	}

	deep := error(errors.New("private depth 9"))
	for depth := 8; depth >= 0; depth-- {
		deep = fmt.Errorf("private depth %d: %w", depth, deep)
	}
	deepAttributes, err := IssueAttributesFromError(deep, "Deep failure", "go.error", true)
	if err != nil {
		t.Fatal(err)
	}
	deepClient := sampleClient(t)
	if err := deepClient.Issue("evt_issue_deep_chain", "2026-08-02T08:15:31Z", deepAttributes); err != nil {
		t.Fatal(err)
	}
	deepPreview := previewPayload(t, deepClient)
	if strings.Count(deepPreview, `"relationship": "reported"`) != 1 ||
		strings.Count(deepPreview, `"relationship": "cause"`) != 7 ||
		!strings.Contains(deepPreview, `"truncated": true`) || strings.Contains(deepPreview, "private depth") {
		t.Fatalf("deep error chain did not preserve its bound: %s", deepPreview)
	}
}

func TestIssueExceptionChainManualStatesAndContradictions(t *testing.T) {
	mechanism := &IssueExceptionMechanism{Type: "go.manual", Handled: true}
	frame := IssueStackFrame{Filename: "checkout.go", Line: 42, Column: 1, Function: "submit"}
	attributes := IssueAttributes{
		Title:     "Checkout failed",
		Level:     "error",
		Exception: &IssueException{Type: "CheckoutFailure", Mechanism: mechanism},
		ExceptionChain: &IssueExceptionChain{
			Entries: []IssueExceptionChainEntry{
				{
					ID:               0,
					Relationship:     IssueExceptionReported,
					Type:             "CheckoutFailure",
					Message:          "approved summary",
					MessageState:     IssueExceptionMessageTruncated,
					Mechanism:        mechanism,
					StackFrames:      []IssueStackFrame{frame},
					StackFramesState: IssueExceptionStackFramesCaptured,
				},
				{
					ID:               1,
					ParentID:         intPtr(0),
					Relationship:     IssueExceptionContext,
					Type:             "RequestContextFailure",
					MessageState:     IssueExceptionMessageRedacted,
					StackFramesState: IssueExceptionStackFramesNotCaptured,
				},
			},
			Truncated: true,
		},
		StackFrames: []IssueStackFrame{frame},
	}
	client := sampleClient(t)
	if err := client.Issue("evt_issue_manual_chain", "2026-08-02T08:15:31Z", attributes); err != nil {
		t.Fatal(err)
	}
	preview := previewPayload(t, client)
	for _, expected := range []string{
		`"message": "approved summary"`,
		`"messageState": "truncated"`,
		`"relationship": "context"`,
		`"stackFramesState": "not_captured"`,
		`"truncated": true`,
	} {
		if !strings.Contains(preview, expected) {
			t.Fatalf("manual chain missing %s: %s", expected, preview)
		}
	}

	bad := attributes
	bad.ExceptionChain = &IssueExceptionChain{Entries: []IssueExceptionChainEntry{{
		ID:               0,
		Relationship:     IssueExceptionCause,
		Type:             "CheckoutFailure",
		MessageState:     IssueExceptionMessageNotCaptured,
		StackFramesState: IssueExceptionStackFramesNotCaptured,
	}}}
	if err := sampleClient(t).Issue("evt_issue_bad_chain", "2026-08-02T08:15:31Z", bad); err == nil ||
		!strings.Contains(err.Error(), "entry 0 must be the parentless reported exception") {
		t.Fatalf("contradictory chain did not fail closed: %v", err)
	}
}

func TestIssueDiagnosticsRejectInvalidBoundsAndValues(t *testing.T) {
	validFrame := IssueStackFrame{Filename: "checkout.go", Line: 1, Column: 1}
	validBreadcrumb := IssueBreadcrumb{Timestamp: "2026-08-02T08:15:30Z", Category: "checkout"}
	tests := []struct {
		name       string
		attributes IssueAttributes
		want       string
	}{
		{
			name: "exception location text",
			attributes: IssueAttributes{Title: "failure", Level: "error", Exception: &IssueException{
				Type: "Error?location",
			}},
			want: "issue exception type is invalid",
		},
		{
			name: "mechanism machine name",
			attributes: IssueAttributes{Title: "failure", Level: "error", Exception: &IssueException{
				Type:      "Error",
				Mechanism: &IssueExceptionMechanism{Type: "bad mechanism", Handled: false},
			}},
			want: "issue exception mechanism type must be a stable machine name",
		},
		{
			name:       "too many frames",
			attributes: IssueAttributes{Title: "failure", Level: "error", StackFrames: make([]IssueStackFrame, 33)},
			want:       "issue stackFrames must contain 1-32 frames",
		},
		{
			name:       "invalid coordinate",
			attributes: IssueAttributes{Title: "failure", Level: "error", StackFrames: []IssueStackFrame{{Filename: "checkout.go", Line: 0, Column: 1}}},
			want:       "issue stack frame line must be a positive integer",
		},
		{
			name:       "too many breadcrumbs",
			attributes: IssueAttributes{Title: "failure", Level: "error", Breadcrumbs: make([]IssueBreadcrumb, 65)},
			want:       "issue breadcrumbs must contain 1-64 entries",
		},
		{
			name:       "breadcrumb timezone",
			attributes: IssueAttributes{Title: "failure", Level: "error", StackFrames: []IssueStackFrame{validFrame}, Breadcrumbs: []IssueBreadcrumb{{Timestamp: "2026-08-02T08:15:30", Category: "checkout"}}},
			want:       "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone",
		},
		{
			name:       "breadcrumb comma fraction",
			attributes: IssueAttributes{Title: "failure", Level: "error", Breadcrumbs: []IssueBreadcrumb{{Timestamp: "2026-08-02T08:15:30,123Z", Category: "checkout"}}},
			want:       "issue breadcrumb timestamp must be RFC 3339 with an explicit timezone",
		},
		{
			name: "breadcrumb non-finite data",
			attributes: IssueAttributes{Title: "failure", Level: "error", Breadcrumbs: []IssueBreadcrumb{{
				Timestamp: validBreadcrumb.Timestamp,
				Category:  validBreadcrumb.Category,
				Data:      map[string]any{"ratio": math.NaN()},
			}}},
			want: "issue breadcrumb data value for ratio must be a finite primitive",
		},
		{
			name: "breadcrumb nested data",
			attributes: IssueAttributes{Title: "failure", Level: "error", Breadcrumbs: []IssueBreadcrumb{{
				Timestamp: validBreadcrumb.Timestamp,
				Category:  validBreadcrumb.Category,
				Data:      map[string]any{"request": map[string]any{"drop": true}},
			}}},
			want: "issue breadcrumb data value for request must be a finite primitive",
		},
		{
			name:       "empty evidence",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{}},
			want:       "issue evidence must contain at least one field",
		},
		{
			name: "fix area without a location",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				LikelyFixArea: &IssueLikelyFixArea{InApp: boolPtr(true)},
			}},
			want: "issue evidence likelyFixArea must identify a code location",
		},
		{
			name: "absolute fix path",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				LikelyFixArea: &IssueLikelyFixArea{File: "/srv/example/app.go"},
			}},
			want: "issue evidence likelyFixArea file must be a safe relative path",
		},
		{
			name: "traversing fix path",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				LikelyFixArea: &IssueLikelyFixArea{File: "internal/../app.go"},
			}},
			want: "issue evidence likelyFixArea file must be a safe relative path",
		},
		{
			name: "URL fix path",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				LikelyFixArea: &IssueLikelyFixArea{File: "https://example.invalid/app.go"},
			}},
			want: "issue evidence likelyFixArea file must be a safe relative path",
		},
		{
			name: "query fix path",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				LikelyFixArea: &IssueLikelyFixArea{File: "internal/app.go?line=42"},
			}},
			want: "issue evidence likelyFixArea file must be a safe relative path",
		},
		{
			name: "empty evidence field list",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				CapturedFields: []string{},
			}},
			want: "issue evidence capturedFields must contain 1-32 fields",
		},
		{
			name: "invalid evidence field",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				CapturedFields: []string{"bad field"},
			}},
			want: "issue evidence capturedFields fields must be unique bounded identifiers",
		},
		{
			name: "duplicate evidence field",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				CapturedFields: []string{"provider.status", "provider.status"},
			}},
			want: "issue evidence capturedFields fields must be unique bounded identifiers",
		},
		{
			name: "conflicting evidence field states",
			attributes: IssueAttributes{Title: "failure", Level: "error", Evidence: &IssueDiagnosticEvidence{
				CapturedFields: []string{"provider.status"},
				MissingFields:  []string{"provider.status"},
			}},
			want: "issue evidence field provider.status has conflicting states",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := sampleClient(t)
			err := client.Issue("evt_invalid_diagnostics", "2026-08-02T08:15:31Z", test.attributes)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("unexpected validation result: %v", err)
			}
		})
	}
}

func TestCaptureIssueStackFramesUsesSanitizedStructuredFrames(t *testing.T) {
	frames := captureIssueStackFramesForTest()
	if len(frames) == 0 || len(frames) > 32 {
		t.Fatalf("unexpected captured frame count: %d", len(frames))
	}
	foundTestFrame := false
	for _, frame := range frames {
		if frame.Filename == "logbrew_test.go" {
			foundTestFrame = true
		}
		if strings.ContainsAny(frame.Filename, `/\\?#`) || frame.Line < 1 || frame.Column < 1 {
			t.Fatalf("captured frame is not privacy-safe: %#v", frame)
		}
	}
	if !foundTestFrame {
		t.Fatalf("captured stack omitted the caller frame: %#v", frames)
	}
}

func captureIssueStackFramesForTest() []IssueStackFrame {
	return CaptureIssueStackFrames()
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
		Description: "  Number of items waiting in the checkout queue.  ",
		Kind:        "gauge",
		Value:       -2,
		Unit:        "{items}",
		Temporality: "instant",
		Metadata:    map[string]any{"service": "worker", "queue": "critical"},
	})
	if err != nil {
		t.Fatal(err)
	}

	_, event := previewEvent(t, client)
	attributes := event.Attributes
	if event.Type != "metric" {
		t.Fatalf("unexpected event type: %#v", event.Type)
	}
	expected := map[string]any{
		"name":        "queue.depth",
		"description": "Number of items waiting in the checkout queue.",
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

func TestMetricRejectsUnsafeDescription(t *testing.T) {
	for _, description := range []string{
		"   ", strings.Repeat("M", 1025), "request\u0085count", "request\u2028count", "request" + string([]byte{0xed, 0xa0, 0x80}) + "count",
	} {
		t.Run(fmt.Sprintf("%q", description), func(t *testing.T) {
			err := sampleClient(t).Metric("evt_metric_001", "2026-06-02T10:00:06Z", MetricAttributes{
				Name: "queue.depth", Description: description, Kind: "gauge", Value: 2, Unit: "{items}", Temporality: "instant",
			})
			if err == nil || !strings.Contains(err.Error(), "metric description must be a non-blank string of at most 1024 non-control characters") {
				t.Fatalf("unexpected error: %v", err)
			}
		})
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
	payload := previewPayload(t, client)
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
			"service":                "checkout",
			"region":                 "global",
			"ignoredObject":          map[string]any{"nested": true},
			"analyticsSchemaVersion": 99,
			"analyticsKind":          "page_view",
			"analyticsSurface":       "/spoofed",
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
			"source":                 "product.action",
			"region":                 "global",
			"service":                "checkout",
			"routeTemplate":          "/checkout/:step",
			"sessionId":              "sess_123",
			"traceId":                "4bf92f3577b34da6a3ce929d0e0e4736",
			"screen":                 "Checkout",
			"funnel":                 "checkout",
			"step":                   "submit",
			"analyticsSchemaVersion": 1,
			"analyticsKind":          "interaction",
			"analyticsSurface":       "/checkout/:step",
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
	payload := previewPayload(t, client)
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
	assertSixEventExample(t, stdout, stderr)
}

func TestRepoCheckoutRealUserSmokeRunsDirectly(t *testing.T) {
	stdout, stderr := runRepoCommand(t, ".", "go", "run", "./examples/real_user_smoke")
	assertSixEventExample(t, stdout, stderr)
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
	assertText(t, stdout, []string{
		`"source": "product.action"`, `"source": "network.milestone"`,
		`"routeTemplate": "/checkout/:step"`, `"routeTemplate": "/v1/payments/:id"`,
		"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01",
	}, []string{"email=user@example.com", "debug=true", "payload", "headers"})
	if stderr != "" {
		t.Fatalf("unexpected stderr: %s", stderr)
	}
}

func TestRepoCheckoutExamplesMakeRunFirstUsefulTelemetryExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-first-useful-telemetry")
	assertText(t, stdout, []string{
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
	}, []string{
		"coupon=private",
		"card=private",
		"authorization",
		"payload",
		"headers",
		"#authorize",
		"?",
	})
	assertText(t, stderr, []string{`"attempts":1`, `"events":7`, `"ok":true`, `"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"`, `"status":202`}, nil)
}

func TestRepoCheckoutExamplesMakeRunHTTPTraceCorrelationExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-http-trace-correlation")
	assertText(t, stdout, []string{
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
	}, []string{
		"coupon=sale",
		"card",
		"payload",
		"#confirm",
		"?",
	})
	assertText(t, stderr, []string{`"appLogHasTrace":true`, `"attempts":1`, `"events":6`, `"ok":true`, `"outgoingTraceparent":"00-4bf92f3577b34da6a3ce929d0e0e4736-b7ad6b7169203331-01"`, `"requestStatus":502`, `"status":202`}, nil)
}

func TestRepoCheckoutExamplesMakeRunExecutesSmoke(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run")
	assertSixEventExample(t, stdout, stderr)
}

func TestRepoCheckoutExamplesMakeRunReadmeExampleExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-readme-example")
	assertSixEventExample(t, stdout, stderr)
}

func TestRepoCheckoutExamplesMakeRunRealUserSmokeExecutesExample(t *testing.T) {
	stdout, stderr := runRepoCommand(t, "./examples", "make", "run-real-user-smoke")
	assertSixEventExample(t, stdout, stderr)
}
