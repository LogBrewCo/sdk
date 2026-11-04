package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
)

func main() {
	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{Endpoint: os.Getenv("LOGBREW_CAPTURE_ENDPOINT")})
	must(err)
	client, err := logbrew.NewAutomaticClient(logbrew.Config{
		APIKey: "LOGBREW_SERVER_API_KEY",
		Context: &logbrew.TelemetryContext{
			SchemaVersion: 1,
			Resource: &logbrew.TelemetryResource{
				Service:    &logbrew.TelemetryNamedVersion{Name: "checkout-api", Version: "1.2.3"},
				Deployment: &logbrew.TelemetryDeployment{Environment: "production", Release: "checkout@1.2.3"},
			},
		},
	}, logbrew.AutomaticDeliveryConfig{Transport: transport})
	must(err)
	slogHandler, err := logbrew.NewSlogHandler(logbrew.SlogHandlerConfig{
		Client:  client,
		Wrapped: slog.NewJSONHandler(os.Stdout, nil),
		Logger:  "checkout-api",
	})
	must(err)
	logger := slog.New(slogHandler)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /checkout/{cartID}", func(w http.ResponseWriter, r *http.Request) {
		logger.InfoContext(r.Context(), "checkout started")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /fail/{cartID}", func(_ http.ResponseWriter, r *http.Request) {
		logger.WarnContext(r.Context(), "payment step failing")
		panic(errors.New("payment declined"))
	})
	handler, err := logbrew.NewHTTPHandlerWithOptions(mux, logbrew.HTTPHandlerConfig{
		Client:               client,
		CaptureRequestMetric: true,
	}, logbrew.WithHTTPServerErrorIssues())
	must(err)

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	server := &http.Server{Handler: handler}
	go func() { _ = server.Serve(listener) }()
	base := "http://" + listener.Addr().String()
	for _, path := range []string{"/checkout/cart-1", "/fail/cart-2"} {
		request, err := http.NewRequest(http.MethodGet, base+path, nil)
		must(err)
		request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		request.Close = true
		if response, err := http.DefaultClient.Do(request); err == nil {
			_ = response.Body.Close()
		}
	}
	must(server.Shutdown(context.Background()))
	_, err = client.Shutdown(nil)
	must(err)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
