package logbrew

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestSupportTicketDraftCreatesPlannedPayloadAndRedactsDiagnostics(t *testing.T) {
	draft, err := CreateSupportTicketDraft(SupportTicketDraftInput{
		Source:      "sdk",
		Category:    "ingest_failure",
		Title:       "Telemetry flush failed",
		Description: "Flush returned usage_limit_exceeded",
		ProjectID:   "proj_123",
		Environment: "production",
		Runtime:     "go1.25",
		Framework:   "net/http",
		SDKPackage:  "github.com/LogBrewCo/sdk/go/logbrew",
		SDKVersion:  "0.1.0",
		Release:     "checkout@1.2.3",
		TraceID:     "4BF92F3577B34DA6A3CE929D0E0E4736",
		EventID:     "evt_checkout_flush",
		Diagnostics: map[string]any{
			"attemptCount": 2,
			"retryable":    false,
			"apiKey":       strings.Join([]string{"lbw", "ingest", "hidden"}, "_"),
			"endpoint":     "https://api.example/ingest?debug=true#frag",
			"localPath":    "/Users/example/app/.env",
			"error":        errors.New("contains hidden message"),
			"headers": map[string]any{
				"authorization": strings.Join([]string{"Bearer", "hidden"}, " "),
				"cookie":        "sid=hidden",
				"accept":        "application/json",
			},
			"events": []any{
				map[string]any{"id": "evt_checkout_flush", "type": "span"},
				map[string]any{"token": "hidden"},
			},
			"callback": func() string { return "ignored" },
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if draft.Source != "sdk" ||
		draft.Category != "ingest_failure" ||
		draft.Title != "Telemetry flush failed" ||
		draft.Description != "Flush returned usage_limit_exceeded" ||
		draft.ProjectID != "proj_123" ||
		draft.Environment != "production" ||
		draft.Runtime != "go1.25" ||
		draft.Framework != "net/http" ||
		draft.SDKPackage != "github.com/LogBrewCo/sdk/go/logbrew" ||
		draft.SDKVersion != "0.1.0" ||
		draft.Release != "checkout@1.2.3" ||
		draft.TraceID != "4bf92f3577b34da6a3ce929d0e0e4736" ||
		draft.EventID != "evt_checkout_flush" {
		t.Fatalf("unexpected support ticket draft: %#v", draft)
	}
	diagnostics := draft.Diagnostics
	if diagnostics["attemptCount"] != 2 || diagnostics["retryable"] != false {
		t.Fatalf("unexpected primitive diagnostics: %#v", diagnostics)
	}
	if diagnostics["apiKey"] != "[redacted]" ||
		diagnostics["endpoint"] != "[redacted-url]/ingest" ||
		diagnostics["localPath"] != "[redacted-path]" {
		t.Fatalf("diagnostics were not redacted: %#v", diagnostics)
	}
	errorInfo := diagnostics["error"].(map[string]any)
	if errorInfo["type"] == "" {
		t.Fatalf("error diagnostic missing type: %#v", errorInfo)
	}
	headers := diagnostics["headers"].(map[string]any)
	if headers["authorization"] != "[redacted]" || headers["cookie"] != "[redacted]" || headers["accept"] != "application/json" {
		t.Fatalf("headers were not sanitized: %#v", headers)
	}
	events := diagnostics["events"].([]any)
	if len(events) != 2 || events[1].(map[string]any)["token"] != "[redacted]" {
		t.Fatalf("events were not sanitized: %#v", events)
	}
	if _, ok := diagnostics["callback"]; ok {
		t.Fatalf("unsupported callback diagnostic should be omitted: %#v", diagnostics)
	}
	serialized, err := json.Marshal(draft)
	if err != nil {
		t.Fatal(err)
	}
	for _, unsafe := range []string{"hidden", "api.example", "/Users/example", "traceparent"} {
		if strings.Contains(string(serialized), unsafe) {
			t.Fatalf("support ticket draft leaked %q: %s", unsafe, string(serialized))
		}
	}
}

func TestSupportTicketDraftRejectsInvalidRouteOwnedValues(t *testing.T) {
	_, err := CreateSupportTicketDraft(SupportTicketDraftInput{
		Source:      "daemon",
		Category:    "ingest_failure",
		Title:       "Telemetry failed",
		Description: "Flush failed",
	})
	if err == nil || !strings.Contains(err.Error(), "support ticket source must be one of: cli, sdk, website, docs, mobile") {
		t.Fatalf("unexpected source error: %v", err)
	}

	_, err = CreateSupportTicketDraft(SupportTicketDraftInput{
		Source:      "sdk",
		Category:    "ingest_failure",
		Title:       "Telemetry failed",
		Description: "Flush failed",
		TraceID:     zeroTraceID,
	})
	if err == nil || !strings.Contains(err.Error(), "trace id must not be all zeros") {
		t.Fatalf("unexpected trace id error: %v", err)
	}

	_, err = CreateSupportTicketDraft(SupportTicketDraftInput{
		Source:      "sdk",
		Category:    "other",
		Title:       "Telemetry failed",
		Description: "Flush failed",
		Diagnostics: map[string]any{
			"bad": make(chan struct{}),
		},
	})
	if err != nil {
		t.Fatalf("unsupported diagnostic values should be omitted, not fail: %v", err)
	}
}
