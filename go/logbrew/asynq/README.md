# LogBrew Asynq integration

This module adds producer-to-worker trace propagation, queue spans for every
attempt, and one correlated issue for terminal failures or panics. It never
copies task payloads, headers, or error messages into telemetry.

```bash
go get github.com/LogBrewCo/sdk/go/logbrew/asynq@latest
```

Enqueue through the integration so it can construct the task with the producer
span's W3C `traceparent` header. Pass normal Asynq options after the config.

```go
info, err := logbrewasynq.EnqueueContext(ctx, asynqClient, "receipt:email", payload,
  logbrewasynq.EnqueueConfig{
    Client: logbrewClient,
    Queue:  "mailers",
  },
  asynq.MaxRetry(5),
)
```

Install the middleware before application middleware that should observe the
active LogBrew trace:

```go
instrumentation, err := logbrewasynq.NewMiddleware(logbrewasynq.Config{
  Client: logbrewClient,
})
if err != nil {
  return err
}
mux.Use(instrumentation)
```

Retryable returned errors remain error spans without creating an issue on every
attempt. The last returned error, `asynq.SkipRetry`, and `asynq.RevokeTask`
create a terminal issue. Each unhandled panic creates an issue before Asynq
recovers it for its retry policy. Issues include exception type, bounded capture
frames, attempt counts when Asynq provides them, queue/task names, and exact
trace/span context. Set `DisableIssues` when the application owns issue capture.
Custom span metadata passes through the core operation metadata filter.

The application still owns Redis, the Asynq client and server lifecycle,
retries, shutdown, and LogBrew flushing.
