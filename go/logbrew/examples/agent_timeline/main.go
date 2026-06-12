package main

import (
	"fmt"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "logbrew-go",
		SDKVersion: "0.1.0",
	})
	must(err)

	traceparent := "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	context, err := logbrew.ParseTraceparent(traceparent)
	must(err)
	outgoing, err := logbrew.CreateTraceparent(context.TraceID, "b7ad6b7169203331", context.TraceFlags)
	must(err)

	action, err := logbrew.CreateProductActionAttributes(logbrew.ProductActionInput{
		Name:          "checkout.started",
		SessionID:     "sess_checkout_123",
		TraceID:       context.TraceID,
		RouteTemplate: "/checkout/:step?email=user@example.com#pay",
		Screen:        "Checkout",
		Funnel:        "checkout",
		Step:          "started",
		Metadata: map[string]any{
			"plan":    "pro",
			"payload": map[string]any{"ignored": true},
		},
	})
	must(err)
	must(client.Action("evt_checkout_started", "2026-06-02T10:00:00Z", action))

	statusCode := 202
	durationMs := 64.5
	network, err := logbrew.CreateNetworkMilestoneAttributes(logbrew.NetworkMilestoneInput{
		RouteTemplate: "https://api.example.com/v1/payments/:id?debug=true#trace",
		Method:        "post",
		StatusCode:    &statusCode,
		DurationMs:    &durationMs,
		SessionID:     "sess_checkout_123",
		TraceID:       context.TraceID,
		Metadata: map[string]any{
			"provider": "payments",
			"region":   "global",
			"headers":  []string{"ignored"},
		},
	})
	must(err)
	must(client.Action("evt_payment_api", "2026-06-02T10:00:01Z", network))

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)
	fmt.Println(outgoing)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
