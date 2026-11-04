package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewgin "github.com/LogBrewCo/sdk/go/logbrew/gin"
	"github.com/gin-gonic/gin"
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

	middleware, err := logbrewgin.NewMiddleware(logbrewgin.Config{
		Client:                   client,
		CaptureRequestMetrics:    true,
		CaptureServerErrorIssues: true,
	})
	must(err)
	gin.SetMode(gin.ReleaseMode)
	router := gin.New()
	router.Use(gin.Recovery(), middleware)
	router.GET("/checkout/:cart_id", func(c *gin.Context) {
		logger.InfoContext(c.Request.Context(), "checkout started")
		c.Status(http.StatusNoContent)
	})
	router.GET("/fail/:cart_id", func(c *gin.Context) {
		logger.WarnContext(c.Request.Context(), "payment step failing")
		panic(errors.New("payment declined"))
	})

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	server := &http.Server{Handler: router}
	go func() { _ = server.Serve(listener) }()
	base := "http://" + listener.Addr().String()
	for _, path := range []string{"/checkout/cart-1", "/fail/cart-2"} {
		request, err := http.NewRequest(http.MethodGet, base+path, nil)
		must(err)
		request.Header.Set("traceparent", "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")
		response, err := http.DefaultClient.Do(request)
		must(err)
		_ = response.Body.Close()
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
