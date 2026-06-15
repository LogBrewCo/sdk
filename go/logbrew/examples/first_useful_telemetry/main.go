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
		SDKName:    "checkout-service",
		SDKVersion: "0.1.0",
	})
	must(err)

	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	context, err := logbrew.ParseTraceparent(traceparent)
	must(err)
	childSpanID := "b7ad6b7169203331"
	outgoingTraceparent, err := logbrew.CreateTraceparent(context.TraceID, childSpanID, context.TraceFlags)
	must(err)

	sessionID := "sess_checkout_123"
	must(client.Release("evt_release_001", "2026-06-02T10:00:00Z", logbrew.ReleaseAttributes{
		Version: "1.2.3",
		Commit:  "abc123def456",
		Notes:   "Checkout service deploy",
		Metadata: map[string]any{
			"service": "checkout",
		},
	}))
	must(client.Environment("evt_environment_001", "2026-06-02T10:00:01Z", logbrew.EnvironmentAttributes{
		Name:   "production",
		Region: "global",
		Metadata: map[string]any{
			"service": "checkout",
		},
	}))
	must(client.Log("evt_log_checkout_started", "2026-06-02T10:00:02Z", logbrew.LogAttributes{
		Message: "checkout started",
		Level:   "info",
		Logger:  "checkout-service",
		Metadata: map[string]any{
			"sessionId": sessionID,
			"traceId":   context.TraceID,
		},
	}))

	action, err := logbrew.CreateProductActionAttributes(logbrew.ProductActionInput{
		Name:          "checkout.submit",
		SessionID:     sessionID,
		TraceID:       context.TraceID,
		RouteTemplate: "https://shop.example/checkout/:cart_id?coupon=private#review",
		Screen:        "Checkout",
		Funnel:        "checkout",
		Step:          "submit",
		Metadata: map[string]any{
			"cartTier": "standard",
			"payload":  map[string]any{"card": "private"},
		},
	})
	must(err)
	must(client.Action("evt_action_checkout_submit", "2026-06-02T10:00:03Z", action))

	statusCode := 202
	networkDurationMs := 81.7
	network, err := logbrew.CreateNetworkMilestoneAttributes(logbrew.NetworkMilestoneInput{
		RouteTemplate: "https://api.example.com/payments/:payment_id?card=private#authorize",
		Method:        "post",
		StatusCode:    &statusCode,
		DurationMs:    &networkDurationMs,
		SessionID:     sessionID,
		TraceID:       context.TraceID,
		Metadata: map[string]any{
			"provider": "payments",
			"headers":  []string{"authorization"},
		},
	})
	must(err)
	must(client.Action("evt_action_payment_api", "2026-06-02T10:00:04Z", network))

	must(client.Metric("evt_metric_http_server_duration", "2026-06-02T10:00:05Z", logbrew.MetricAttributes{
		Name:        "http.server.duration",
		Kind:        "histogram",
		Value:       networkDurationMs,
		Unit:        "ms",
		Temporality: "delta",
		Metadata: map[string]any{
			"method":        "POST",
			"routeTemplate": "/checkout/:cart_id",
			"sessionId":     sessionID,
			"statusCode":    statusCode,
			"traceId":       context.TraceID,
		},
	}))

	spanDurationMs := 92.4
	span, err := logbrew.SpanAttributesFromTraceparent(logbrew.TraceparentSpanInput{
		Traceparent: traceparent,
		Name:        "POST /checkout/:cart_id",
		SpanID:      childSpanID,
		Status:      "ok",
		DurationMs:  &spanDurationMs,
		Metadata: map[string]any{
			"method":        "POST",
			"routeTemplate": "/checkout/:cart_id",
			"sampled":       context.Sampled,
			"sessionId":     sessionID,
		},
	})
	must(err)
	must(client.Span("evt_span_checkout_request", "2026-06-02T10:00:06Z", span))

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)

	response, err := client.Shutdown(logbrew.AlwaysAcceptTransport())
	must(err)
	_ = json.NewEncoder(os.Stderr).Encode(map[string]any{
		"attempts":            response.Attempts,
		"events":              7,
		"ok":                  true,
		"outgoingTraceparent": outgoingTraceparent,
		"status":              response.StatusCode,
	})
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
