package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	client, err := logbrew.NewClient(logbrew.Config{
		APIKey:     "LOGBREW_API_KEY",
		SDKName:    "checkout-api",
		SDKVersion: "1.0.0",
	})
	must(err)

	parentTrace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		SpanID:      "a7ad6b7169203330",
	})
	must(err)

	var downstreamTraceparent string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamTraceparent = r.Header.Get("traceparent")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte("accepted"))
	}))
	defer server.Close()

	timestamps := []time.Time{
		time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC),
		time.Date(2026, 6, 2, 10, 0, 0, int(3*time.Millisecond), time.UTC),
		time.Date(2026, 6, 2, 10, 0, 0, int(10*time.Millisecond), time.UTC),
		time.Date(2026, 6, 2, 10, 0, 0, int(16*time.Millisecond), time.UTC),
		time.Date(2026, 6, 2, 10, 0, 0, int(28*time.Millisecond), time.UTC),
		time.Date(2026, 6, 2, 10, 0, 0, int(43*time.Millisecond), time.UTC),
	}
	nextTimestamp := func() time.Time {
		current := timestamps[0]
		if len(timestamps) > 1 {
			timestamps = timestamps[1:]
		}
		return current
	}

	transport, err := logbrew.NewHTTPClientTransport(logbrew.HTTPClientTransportConfig{
		Client:        client,
		Base:          http.DefaultTransport,
		RouteTemplate: "/payments/:payment_id",
		EventIDPrefix: "go_http_client_example",
		Metadata: map[string]any{
			"service": "checkout-api",
		},
		CapturePhaseTimings: true,
		SpanIDFactory: func() string {
			return "b7ad6b7169203331"
		},
		Now: nextTimestamp,
	})
	must(err)

	ctx := logbrew.ContextWithLogBrewTrace(context.Background(), parentTrace)
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodGet,
		server.URL+"/payments/123?coupon=summer#receipt",
		nil,
	)
	must(err)
	request.Header.Set("traceparent", "spoofed")

	httpClient := &http.Client{Transport: transport}
	response, err := httpClient.Do(request)
	must(err)
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)

	payload, err := client.PreviewJSON()
	must(err)
	fmt.Println(payload)
	must(json.NewEncoder(os.Stderr).Encode(map[string]any{
		"callerTraceparent":     request.Header.Get("traceparent"),
		"downstreamTraceparent": downstreamTraceparent,
		"events":                client.PendingEvents(),
		"ok":                    true,
		"status":                response.StatusCode,
	}))
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
