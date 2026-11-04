package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
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
	exporter, err := logbrewotel.NewSpanExporter(client, logbrewotel.SpanExporterConfig{EventIDPrefix: "checkout_otel"})
	must(err)
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	tracer := otel.Tracer("checkout-api")

	slogHandler, err := logbrew.NewSlogHandler(logbrew.SlogHandlerConfig{
		Client:  client,
		Wrapped: slog.NewJSONHandler(os.Stdout, nil),
		Logger:  "checkout-api",
	})
	must(err)
	logger := slog.New(slogHandler)

	instrument := func(route string, handle func(context.Context) error) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ctx := otel.GetTextMapPropagator().Extract(r.Context(), propagation.HeaderCarrier(r.Header))
			ctx, span := tracer.Start(ctx, r.Method+" "+route, trace.WithSpanKind(trace.SpanKindServer),
				trace.WithAttributes(attribute.String("http.request.method", r.Method), attribute.String("http.route", route)))
			defer span.End()
			if copied, ok, err := logbrewotel.TraceContextFromContext(ctx, spanID()); err == nil && ok {
				ctx = logbrew.ContextWithLogBrewTrace(ctx, copied)
			}
			status := http.StatusNoContent
			if err := handle(ctx); err != nil {
				span.RecordError(err)
				span.SetStatus(codes.Error, "request failed")
				status = http.StatusInternalServerError
			}
			span.SetAttributes(attribute.Int("http.response.status_code", status))
			w.WriteHeader(status)
		}
	}
	mux := http.NewServeMux()
	mux.Handle("GET /checkout/{cartID}", instrument("/checkout/{cartID}", func(ctx context.Context) error {
		logger.InfoContext(ctx, "checkout started")
		return nil
	}))
	mux.Handle("GET /fail/{cartID}", instrument("/fail/{cartID}", func(ctx context.Context) error {
		logger.WarnContext(ctx, "payment step failing")
		return errors.New("payment declined")
	}))

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	server := &http.Server{Handler: mux}
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
	must(provider.Shutdown(context.Background()))
	_, err = client.Shutdown(nil)
	must(err)
}

func spanID() string {
	value := make([]byte, 8)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
