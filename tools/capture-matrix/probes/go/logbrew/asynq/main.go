package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewasynq "github.com/LogBrewCo/sdk/go/logbrew/asynq"
	"github.com/hibiken/asynq"
)

func main() {
	free, err := net.Listen("tcp", "127.0.0.1:0")
	must(err)
	address := free.Addr().String()
	_, port, err := net.SplitHostPort(address)
	must(err)
	must(free.Close())
	redis := exec.Command("redis-server", "--bind", "127.0.0.1", "--port", port, "--save", "", "--appendonly", "no")
	must(redis.Start())
	defer func() { _ = redis.Process.Kill(); _ = redis.Wait() }()
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(20 * time.Millisecond) {
		if connection, err := net.Dial("tcp", address); err == nil {
			_ = connection.Close()
			break
		}
		if time.Now().After(deadline) {
			panic("redis-server did not start")
		}
	}
	redisOpt := asynq.RedisClientOpt{Addr: address}

	transport, err := logbrew.NewHTTPTransport(logbrew.HTTPTransportConfig{Endpoint: os.Getenv("LOGBREW_CAPTURE_ENDPOINT")})
	must(err)
	client, err := logbrew.NewAutomaticClient(logbrew.Config{
		APIKey: "LOGBREW_SERVER_API_KEY",
		Context: &logbrew.TelemetryContext{
			SchemaVersion: 1,
			Resource: &logbrew.TelemetryResource{
				Service:    &logbrew.TelemetryNamedVersion{Name: "checkout-worker", Version: "1.2.3"},
				Deployment: &logbrew.TelemetryDeployment{Environment: "production", Release: "checkout@1.2.3"},
			},
		},
	}, logbrew.AutomaticDeliveryConfig{Transport: transport})
	must(err)
	slogHandler, err := logbrew.NewSlogHandler(logbrew.SlogHandlerConfig{
		Client:  client,
		Wrapped: slog.NewJSONHandler(os.Stdout, nil),
		Logger:  "checkout-worker",
	})
	must(err)
	logger := slog.New(slogHandler)

	var done sync.WaitGroup
	instrumentation, err := logbrewasynq.NewMiddleware(logbrewasynq.Config{Client: client})
	must(err)
	mux := asynq.NewServeMux()
	mux.Use(func(next asynq.Handler) asynq.Handler {
		return asynq.HandlerFunc(func(ctx context.Context, task *asynq.Task) error {
			defer done.Done()
			return next.ProcessTask(ctx, task)
		})
	}, instrumentation)
	mux.HandleFunc("receipt:email", func(ctx context.Context, _ *asynq.Task) error {
		logger.InfoContext(ctx, "receipt sent")
		return nil
	})
	mux.HandleFunc("payment:capture", func(ctx context.Context, _ *asynq.Task) error {
		logger.WarnContext(ctx, "payment step failing")
		return errors.New("payment declined")
	})
	server := asynq.NewServer(redisOpt, asynq.Config{Concurrency: 2, Queues: map[string]int{"mailers": 1}, LogLevel: asynq.ErrorLevel})
	must(server.Start(mux))

	trace, err := logbrew.NewTraceContext(logbrew.TraceContextInput{Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"})
	must(err)
	ctx := logbrew.ContextWithLogBrewTrace(context.Background(), trace)
	producer := asynq.NewClient(redisOpt)
	done.Add(2)
	for _, taskType := range []string{"receipt:email", "payment:capture"} {
		_, err := logbrewasynq.EnqueueContext(ctx, producer, taskType, []byte(`{"cart":"cart-1"}`),
			logbrewasynq.EnqueueConfig{Client: client, Queue: "mailers"}, asynq.MaxRetry(0))
		must(err)
	}
	done.Wait()
	server.Shutdown()
	must(producer.Close())
	_, err = client.Shutdown(nil)
	must(err)
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
