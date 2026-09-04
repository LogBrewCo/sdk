// Package logbrewasynq correlates Asynq producers and workers with LogBrew
// queue spans and privacy-bounded job issues.
package logbrewasynq

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	"github.com/hibiken/asynq"
)

const defaultEventIDPrefix = "go_asynq"

// Enqueuer is implemented by *asynq.Client.
type Enqueuer interface {
	EnqueueContext(context.Context, *asynq.Task, ...asynq.Option) (*asynq.TaskInfo, error)
}

// EnqueueConfig controls producer telemetry and task propagation.
type EnqueueConfig struct {
	Client        *logbrew.Client
	Queue         string
	Headers       map[string]string
	EventIDPrefix string
	Metadata      map[string]any
	SpanIDFactory func() string
	Now           func() time.Time
	OnError       func(error)
}

// Config controls worker middleware. Terminal returned errors and unhandled
// panics create issues by default; DisableIssues leaves them as spans only.
type Config struct {
	Client        *logbrew.Client
	DisableIssues bool
	EventIDPrefix string
	Metadata      map[string]any
	SpanIDFactory func() string
	Now           func() time.Time
	OnError       func(error)
}

// EnqueueContext constructs and enqueues one task inside a producer span. The
// generated traceparent replaces case variants in app-owned task headers;
// payloads and headers are never copied into telemetry.
func EnqueueContext(
	ctx context.Context,
	enqueuer Enqueuer,
	taskType string,
	payload []byte,
	config EnqueueConfig,
	options ...asynq.Option,
) (*asynq.TaskInfo, error) {
	if config.Client == nil {
		return nil, sdkError("Asynq producer client must be non-nil")
	}
	if interfaceIsNil(enqueuer) {
		return nil, sdkError("Asynq enqueuer must be non-nil")
	}
	if strings.TrimSpace(taskType) == "" {
		return nil, sdkError("Asynq task type must be non-empty")
	}
	queue := strings.TrimSpace(config.Queue)
	if queue == "" {
		queue = "default"
	}
	headers := taskHeaders(config.Headers)
	var task *asynq.Task
	buildTask := func() *asynq.Task {
		if task == nil {
			task = asynq.NewTaskWithHeaders(taskType, payload, headers)
		}
		return task
	}
	messageCount := 1
	options = append(slices.Clone(options), asynq.Queue(queue))
	return logbrew.QueueOperationWithLogBrewSpan(ctx, config.Client, "enqueue "+taskType, func(operationCtx context.Context) (*asynq.TaskInfo, error) {
		return enqueuer.EnqueueContext(operationCtx, buildTask(), options...)
	}, logbrew.QueueOperationConfig{
		System:            "asynq",
		OperationKind:     "send",
		QueueName:         queue,
		TaskName:          taskType,
		MessageCount:      &messageCount,
		EventIDPrefix:     prefix(config.EventIDPrefix),
		Metadata:          config.Metadata,
		SpanIDFactory:     config.SpanIDFactory,
		Now:               config.Now,
		OnError:           config.OnError,
		TraceparentSetter: func(value string) error { headers["traceparent"] = value; buildTask(); return nil },
	})
}

// NewMiddleware returns Asynq middleware that continues producer traces,
// records each processing attempt, and captures terminal returned errors plus
// every unhandled panic.
func NewMiddleware(config Config) (asynq.MiddlewareFunc, error) {
	if config.Client == nil {
		return nil, sdkError("Asynq middleware client must be non-nil")
	}
	return func(next asynq.Handler) asynq.Handler {
		return asynq.HandlerFunc(func(ctx context.Context, task *asynq.Task) error {
			if interfaceIsNil(next) || task == nil {
				return sdkError("Asynq middleware requires a handler and task")
			}
			queue := "default"
			if value, ok := asynq.GetQueueName(ctx); ok && strings.TrimSpace(value) != "" {
				queue = value
			}
			metadata := taskMetadata(ctx, config.Metadata)
			messageCount := 1
			_, err := logbrew.QueueOperationWithLogBrewSpan(ctx, config.Client, "process "+task.Type(), func(operationCtx context.Context) (struct{}, error) {
				defer func() {
					if recovered := recover(); recovered != nil {
						if !config.DisableIssues {
							attributes, issueErr := logbrew.IssueAttributesFromPanic(recovered, "Asynq task panicked", "asynq.process", false, logbrew.CaptureIssueStackFrames())
							captureIssue(operationCtx, task.Type(), queue, attributes, issueErr, config)
						}
						panic(recovered)
					}
				}()
				handlerErr := next.ProcessTask(operationCtx, task)
				if handlerErr != nil && !config.DisableIssues && terminal(operationCtx, handlerErr) {
					attributes, issueErr := logbrew.IssueAttributesFromError(handlerErr, "Asynq task failed", "asynq.process", true)
					captureIssue(operationCtx, task.Type(), queue, attributes, issueErr, config)
				}
				return struct{}{}, handlerErr
			}, logbrew.QueueOperationConfig{
				System:              "asynq",
				OperationKind:       "process",
				QueueName:           queue,
				TaskName:            task.Type(),
				MessageCount:        &messageCount,
				EventIDPrefix:       prefix(config.EventIDPrefix),
				Metadata:            metadata,
				IncomingTraceparent: traceparent(task.Headers()),
				SpanIDFactory:       config.SpanIDFactory,
				Now:                 config.Now,
				OnError:             config.OnError,
			})
			return err
		})
	}, nil
}

func terminal(ctx context.Context, err error) bool {
	if errors.Is(err, asynq.SkipRetry) || errors.Is(err, asynq.RevokeTask) {
		return true
	}
	retry, retryOK := asynq.GetRetryCount(ctx)
	maximum, maximumOK := asynq.GetMaxRetry(ctx)
	return retryOK && maximumOK && retry >= maximum
}

func captureIssue(ctx context.Context, taskType, queue string, attributes logbrew.IssueAttributes, err error, config Config) {
	if err != nil {
		report(config.OnError, err)
		return
	}
	trace, ok := logbrew.LogBrewTraceFromContext(ctx)
	if !ok {
		report(config.OnError, &logbrew.SdkError{Code: "capture_error", Message: "Asynq issue trace unavailable"})
		return
	}
	attributes.Metadata = taskMetadata(ctx, config.Metadata)
	attributes.Metadata["queueSystem"] = "asynq"
	attributes.Metadata["queueName"] = queue
	attributes.Metadata["taskName"] = taskType
	attributes.Metadata["terminal"] = true
	attributes = logbrew.IssueAttributesWithTrace(ctx, attributes)
	if err := config.Client.Issue(fmt.Sprintf("%s_issue_%s", prefix(config.EventIDPrefix), trace.SpanID), now(config.Now).Format(time.RFC3339Nano), attributes); err != nil {
		report(config.OnError, err)
	}
}

func taskHeaders(input map[string]string) map[string]string {
	headers := maps.Clone(input)
	if headers == nil {
		headers = map[string]string{}
	}
	for key := range headers {
		if strings.EqualFold(key, "traceparent") {
			delete(headers, key)
		}
	}
	return headers
}

func traceparent(headers map[string]string) string {
	if value, ok := headers["traceparent"]; ok {
		return value
	}
	for key, value := range headers {
		if strings.EqualFold(key, "traceparent") {
			return value
		}
	}
	return ""
}

func taskMetadata(ctx context.Context, metadata map[string]any) map[string]any {
	metadata = maps.Clone(metadata)
	if metadata == nil {
		metadata = map[string]any{}
	}
	if retry, ok := asynq.GetRetryCount(ctx); ok {
		metadata["retryCount"] = retry
	}
	if maximum, ok := asynq.GetMaxRetry(ctx); ok {
		metadata["maxRetry"] = maximum
	}
	return metadata
}

func interfaceIsNil(value any) bool {
	if value == nil {
		return true
	}
	typed := reflect.ValueOf(value)
	return typed.Kind() == reflect.Pointer && typed.IsNil()
}

func sdkError(message string) error {
	return &logbrew.SdkError{Code: "configuration_error", Message: message}
}

func prefix(value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return defaultEventIDPrefix
}

func now(clock func() time.Time) time.Time {
	if clock != nil {
		return clock().UTC()
	}
	return time.Now().UTC()
}

func report(callback func(error), err error) {
	if callback != nil && err != nil {
		func() { defer func() { _ = recover() }(); callback(err) }()
	}
}
