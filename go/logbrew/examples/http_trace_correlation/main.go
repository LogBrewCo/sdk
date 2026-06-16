package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "checkout-service",
		SDKVersion: "0.1.0",
	})
	must(err)

	must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Checkout service deploy",
	}))
	must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
	}))

	var appLog bytes.Buffer
	slogHandler, err := logbrew.NewSlogHandler(logbrew.SlogHandlerConfig{
		Client:  client,
		Wrapped: slog.NewJSONHandler(&appLog, nil),
		Logger:  "checkout-service",
		Now: func() time.Time {
			return time.Date(2026, 6, 2, 10, 0, 2, 0, time.UTC)
		},
	})
	must(err)
	logger := slog.New(slogHandler)

	baseTime := time.Date(2026, 6, 2, 10, 0, 3, 0, time.UTC)
	now := sequenceClock(baseTime, baseTime.Add(37*time.Millisecond))
	handler, err := logbrew.NewHTTPHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		logger.InfoContext(r.Context(), "checkout handler reached",
			slog.String("cartTier", "standard"),
			slog.Any("payload", map[string]any{"card": "ignored"}),
		)
		must(client.Issue("evt_issue_checkout_upstream", "2026-06-02T10:00:03Z", logbrew.IssueAttributesWithTrace(r.Context(), logbrew.IssueAttributes{
			Title:   "checkout upstream failed",
			Level:   "error",
			Message: "payment provider timed out",
		})))
		http.Error(w, "upstream failed", http.StatusBadGateway)
	}), logbrew.HTTPHandlerConfig{
		Client:               client,
		RouteTemplate:        "https://api.example/checkout/:cart_id?coupon=sale#confirm",
		CaptureRequestMetric: true,
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: now,
	})
	must(err)

	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	request := httptest.NewRequest(http.MethodGet, "/checkout/cart_123?coupon=sale", nil)
	request.Header.Set("traceparent", traceparent)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)

	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	outgoingTraceparent, err := logbrew.CreateTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "b7ad6b7169203331", "01")
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"appLogHasTrace":      strings.Contains(appLog.String(), "4bf92f3577b34da6a3ce929d0e0e4736"),
		"attempts":            response.Attempts,
		"events":              6,
		"ok":                  true,
		"outgoingTraceparent": outgoingTraceparent,
		"requestStatus":       recorder.Code,
		"status":              response.StatusCode,
	})
}

func sequenceClock(times ...time.Time) func() time.Time {
	index := 0
	return func() time.Time {
		if index >= len(times) {
			return times[len(times)-1]
		}
		value := times[index]
		index++
		return value
	}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
