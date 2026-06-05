package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "logbrew-go",
		SDKVersion: "0.1.0",
	})
	if err != nil {
		panic(err)
	}

	must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Public release marker",
	}))
	must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
	}))
	must(client.Issue("evt_issue_001", "2026-06-02T10:00:02Z", logbrew.IssueAttributes{
		Title:   "Checkout timeout",
		Level:   "error",
		Message: "Request timed out after retry budget",
	}))
	must(client.Log("evt_log_001", "2026-06-02T10:00:03Z", logbrew.LogAttributes{
		Message: "worker started",
		Level:   "info",
		Logger:  "job-runner",
	}))
	duration := 12.5
	must(client.Span("evt_span_001", "2026-06-02T10:00:04Z", logbrew.SpanAttributes{
		Name:       "GET /health",
		TraceID:    "trace_001",
		SpanID:     "span_001",
		Status:     "ok",
		DurationMs: &duration,
	}))
	must(client.Action("evt_action_001", "2026-06-02T10:00:05Z", logbrew.ActionAttributes{
		Name:   "deploy",
		Status: "success",
	}))

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)

	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"ok":       true,
		"status":   response.StatusCode,
		"attempts": response.Attempts,
		"events":   6,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
