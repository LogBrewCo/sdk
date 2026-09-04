package logbrewasynq

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"github.com/hibiken/asynq"
)

func TestProducerAndWorkerCorrelateTerminalEvidenceWithoutPrivateData(t *testing.T) {
	client := testClient(t)
	parent, err := logbrew.NewTraceContext(logbrew.TraceContextInput{
		Traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
		SpanID:      "3333333333333333",
	})
	if err != nil {
		t.Fatal(err)
	}
	producer := &recordingEnqueuer{}
	options := make([]asynq.Option, 1, 2)
	options[0] = asynq.MaxRetry(3)
	optionBacking := options[:2]
	optionBacking[1] = asynq.Queue("caller-owned")
	info, err := EnqueueContext(
		logbrew.ContextWithLogBrewTrace(context.Background(), parent),
		producer,
		"checkout:charge",
		[]byte(`{"card":"private-payload"}`),
		EnqueueConfig{
			Client:        client,
			Queue:         "payments",
			Headers:       map[string]string{"Authorization": "private-header", "TraceParent": "stale-parent"},
			SpanIDFactory: idFactory("4444444444444444"),
			Now:           fixedNow,
		},
		options...,
	)
	if err != nil || info == nil || producer.task == nil {
		t.Fatalf("enqueue result=%#v task=%#v err=%v", info, producer.task, err)
	}
	if got := producer.task.Headers()["traceparent"]; got != "00-11111111111111111111111111111111-4444444444444444-01" {
		t.Fatalf("unexpected propagated traceparent %q", got)
	}
	if _, exists := producer.task.Headers()["TraceParent"]; exists {
		t.Fatal("stale case-variant traceparent survived")
	}
	if producer.task.Headers()["Authorization"] != "private-header" || !strings.Contains(string(producer.task.Payload()), "private-payload") {
		t.Fatal("adapter changed app-owned task data")
	}
	lastOption := producer.options[len(producer.options)-1]
	if lastOption.Type() != asynq.QueueOpt || lastOption.Value() != "payments" {
		t.Fatalf("queue option was not authoritative: %#v", producer.options)
	}
	if optionBacking[1].Value() != "caller-owned" {
		t.Fatal("adapter changed the caller's option backing array")
	}

	middleware, err := NewMiddleware(Config{Client: client, Metadata: map[string]any{"component": "billing-worker"}, SpanIDFactory: idFactory("5555555555555555"), Now: fixedNow})
	if err != nil {
		t.Fatal(err)
	}
	privateErr := fmt.Errorf("private gateway response: %w", asynq.SkipRetry)
	handler := middleware(asynq.HandlerFunc(func(ctx context.Context, task *asynq.Task) error {
		trace, ok := logbrew.LogBrewTraceFromContext(ctx)
		if !ok || trace.TraceID != parent.TraceID || trace.ParentSpanID != "4444444444444444" || trace.SpanID != "5555555555555555" {
			t.Fatalf("unexpected worker trace %#v", trace)
		}
		return errors.Join(client.Log("worker_log", fixedNow().Format(time.RFC3339Nano), logbrew.LogAttributesWithTrace(ctx, logbrew.LogAttributes{
			Message: "job reached payment provider",
			Level:   "info",
		})), privateErr)
	}))
	if got := handler.ProcessTask(context.Background(), producer.task); !errors.Is(got, asynq.SkipRetry) {
		t.Fatalf("worker replaced terminal error: %v", got)
	}

	payload := preview(t, client)
	for _, want := range []string{
		`"name": "queue:enqueue checkout:charge"`, `"spanId": "4444444444444444"`,
		`"name": "queue:process checkout:charge"`, `"spanId": "5555555555555555"`,
		`"parentSpanId": "4444444444444444"`, `"queueSystem": "asynq"`,
		`"queueName": "payments"`, `"taskName": "checkout:charge"`,
		`"type": "log"`, `"type": "issue"`, `"title": "Asynq task failed"`,
		`"mechanism": {`, `"type": "asynq.process"`, `"handled": true`,
	} {
		if !strings.Contains(payload, want) {
			t.Fatalf("missing %s in payload: %s", want, payload)
		}
	}
	for _, private := range []string{"private-payload", "private-header", "private gateway response", "stale-parent", "Authorization"} {
		if strings.Contains(payload, private) {
			t.Fatalf("telemetry leaked %q: %s", private, payload)
		}
	}
	if strings.Count(payload, `"component": "billing-worker"`) != 2 {
		t.Fatalf("worker metadata missing from its span or issue: %s", payload)
	}
}

func TestWorkerRetryAndPanicSemantics(t *testing.T) {
	for _, test := range []struct {
		name      string
		handler   asynq.Handler
		wantPanic bool
		wantIssue bool
		disable   bool
	}{
		{"retryable", asynq.HandlerFunc(func(context.Context, *asynq.Task) error { return errors.New("private retry detail") }), false, false, false},
		{"revoked", asynq.HandlerFunc(func(context.Context, *asynq.Task) error {
			return fmt.Errorf("private revoke detail: %w", asynq.RevokeTask)
		}), false, true, false},
		{"panic", asynq.HandlerFunc(func(context.Context, *asynq.Task) error { panic("private panic value") }), true, true, false},
		{"panic disabled", asynq.HandlerFunc(func(context.Context, *asynq.Task) error { panic("private panic value") }), true, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t)
			config := Config{Client: client, SpanIDFactory: idFactory("6666666666666666"), Now: fixedNow}
			config.DisableIssues = test.disable
			middleware, err := NewMiddleware(config)
			if err != nil {
				t.Fatal(err)
			}
			task := asynq.NewTaskWithHeaders("reports:daily", []byte("private body"), map[string]string{"x-debug": "private header"})
			panicked := didPanic(func() { _ = middleware(test.handler).ProcessTask(context.Background(), task) })
			if panicked != test.wantPanic {
				t.Fatalf("panic=%t want %t", panicked, test.wantPanic)
			}
			payload := preview(t, client)
			if got := strings.Count(payload, `"type": "issue"`); (got == 1) != test.wantIssue {
				t.Fatalf("issue count=%d wantIssue=%t: %s", got, test.wantIssue, payload)
			}
			if test.wantPanic && test.wantIssue && (!strings.Contains(payload, `"title": "Asynq task panicked"`) || !strings.Contains(payload, `"handled": false`)) {
				t.Fatalf("panic evidence incomplete: %s", payload)
			}
			for _, private := range []string{"private retry detail", "private revoke detail", "private panic value", "private body", "private header"} {
				if strings.Contains(payload, private) {
					t.Fatalf("telemetry leaked %q: %s", private, payload)
				}
			}
		})
	}
}

func TestConfigurationRequiresClients(t *testing.T) {
	if got := traceparent(map[string]string{"TraceParent": "value"}); got != "value" {
		t.Fatalf("case-insensitive traceparent lookup=%q", got)
	}
	if _, err := NewMiddleware(Config{}); err == nil || !strings.Contains(err.Error(), "client") {
		t.Fatalf("expected middleware client error, got %v", err)
	}
	client := testClient(t)
	var enqueuer *recordingEnqueuer
	if _, err := EnqueueContext(context.Background(), enqueuer, "task", nil, EnqueueConfig{Client: client}); err == nil || !strings.Contains(err.Error(), "enqueuer") {
		t.Fatalf("expected enqueuer error, got %v", err)
	}
	if _, err := EnqueueContext(context.Background(), &recordingEnqueuer{}, " ", nil, EnqueueConfig{Client: client}); err == nil || !strings.Contains(err.Error(), "task type") {
		t.Fatalf("expected task type error, got %v", err)
	}
	middleware, err := NewMiddleware(Config{Client: client})
	if err != nil {
		t.Fatal(err)
	}
	if err := middleware(nil).ProcessTask(context.Background(), asynq.NewTask("task", nil)); err == nil {
		t.Fatal("expected nil handler error")
	}
	if err := middleware(asynq.HandlerFunc(func(context.Context, *asynq.Task) error { return nil })).ProcessTask(context.Background(), nil); err == nil {
		t.Fatal("expected nil task error")
	}
}

type recordingEnqueuer struct {
	task    *asynq.Task
	options []asynq.Option
}

func (e *recordingEnqueuer) EnqueueContext(_ context.Context, task *asynq.Task, options ...asynq.Option) (*asynq.TaskInfo, error) {
	e.task = task
	e.options = options
	return &asynq.TaskInfo{Queue: "payments", Type: task.Type()}, nil
}

func testClient(t *testing.T) *logbrew.Client {
	t.Helper()
	client, err := logbrew.NewClient(logbrew.Config{APIKey: "key", SDKName: "go-asynq-test", SDKVersion: "0.1.0", DisableRuntimeContext: true})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func preview(t *testing.T, client *logbrew.Client) string {
	t.Helper()
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func idFactory(ids ...string) func() string {
	index := 0
	return func() string {
		id := ids[index]
		index++
		return id
	}
}

func fixedNow() time.Time { return time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC) }

func didPanic(run func()) (panicked bool) {
	defer func() { panicked = recover() != nil }()
	run()
	return false
}
