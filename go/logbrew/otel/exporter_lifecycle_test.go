package logbrewotel_test

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/LogBrewCo/sdk/go/logbrew"
	logbrewotel "github.com/LogBrewCo/sdk/go/logbrew/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

func TestSpanExporterShutdownDeadlineDuringExport(t *testing.T) {
	t.Parallel()

	for _, stage := range []string{"span conversion", "timestamp callback"} {
		t.Run(stage, func(t *testing.T) {
			t.Parallel()

			client := newLifecycleClient(t)
			spans := lifecycleSpans(t)
			started, release := make(chan struct{}), make(chan struct{})
			unblock := sync.OnceFunc(func() { close(release) })
			defer unblock()

			config := lifecycleConfig()
			active := spans[1]
			if stage == "timestamp callback" {
				config.Now = func() time.Time {
					close(started)
					<-release

					return lifecycleTime
				}
			} else {
				active = gatedLifecycleSpan{ReadOnlySpan: active, started: started, release: release}
			}

			exporter := newLifecycleExporter(t, client, config)
			exported := make(chan error, 1)
			go func() { exported <- exporter.ExportSpans(t.Context(), []sdktrace.ReadOnlySpan{active}) }()
			waitLifecycleSignal(t, started)

			logged := writeLifecycleLogs(t.Context(), client, active.SpanContext(), 8)
			ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
			defer cancel()

			stopped := make(chan error, 1)
			go func() { stopped <- exporter.Shutdown(ctx) }()
			shutdownErr := waitLifecycleResult(t, stopped)
			unblock()
			assertLifecycleResult(t, waitLifecycleResult(t, exported))
			assertLifecycleResult(t, waitLifecycleResult(t, logged))

			if !errors.Is(shutdownErr, context.DeadlineExceeded) {
				t.Fatalf("shutdown must wait for active export within its context, got %v", shutdownErr)
			}

			assertLifecycleResult(t, exporter.Shutdown(t.Context()))
			assertLifecycleResult(t, writeLifecycleLog(t.Context(), client, active.SpanContext(), "after_shutdown"))
			if err := exporter.ExportSpans(t.Context(), spans); err == nil {
				t.Fatal("closed exporter accepted another span batch")
			}

			payload, events := lifecycleEvents(t, client)
			assertLifecycleEvents(t, events, []sdktrace.ReadOnlySpan{spans[1]}, 9)
			assertLifecyclePrivacy(t, payload)
		})
	}
}

func TestSpanExporterShutdownWaitsForActiveExport(t *testing.T) {
	t.Parallel()

	client := newLifecycleClient(t)
	spans := lifecycleSpans(t)
	exporter := newLifecycleExporter(t, client, lifecycleConfig())
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), spans[:1]))

	started, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()

	active := gatedLifecycleSpan{ReadOnlySpan: spans[1], started: started, release: release}
	exported := make(chan error, 1)
	go func() { exported <- exporter.ExportSpans(t.Context(), []sdktrace.ReadOnlySpan{active}) }()
	waitLifecycleSignal(t, started)

	stopped := make(chan error, 1)
	go func() { stopped <- exporter.Shutdown(t.Context()) }()
	logged := writeLifecycleLogs(t.Context(), client, active.SpanContext(), 8)

	select {
	case err := <-stopped:
		unblock()
		assertLifecycleResult(t, waitLifecycleResult(t, exported))
		assertLifecycleResult(t, waitLifecycleResult(t, logged))
		t.Fatalf("shutdown returned before the active span was queued: %v", err)
	case <-time.After(50 * time.Millisecond):
	}

	unblock()
	assertLifecycleResult(t, waitLifecycleResult(t, exported))
	assertLifecycleResult(t, waitLifecycleResult(t, stopped))
	assertLifecycleResult(t, waitLifecycleResult(t, logged))
	assertLifecycleResult(t, exporter.Shutdown(t.Context()))

	payload, events := lifecycleEvents(t, client)
	assertLifecycleEvents(t, events, spans[:2], 8)
	assertLifecyclePrivacy(t, payload)
}

func TestSpanExporterCancelledExportAndDeliveryRetry(t *testing.T) {
	t.Parallel()

	client := newLifecycleClient(t)
	spans := lifecycleSpans(t)
	exporter := newLifecycleExporter(t, client, lifecycleConfig())
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), spans[:1]))

	ctx, cancel := context.WithCancel(t.Context())
	cancel()

	if err := exporter.ExportSpans(ctx, spans[1:]); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled export returned %v", err)
	}

	if client.PendingEvents() != 1 {
		t.Fatal("cancelled export changed spans already in the shared queue")
	}

	logged := writeLifecycleLogs(t.Context(), client, spans[1].SpanContext(), 8)
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), spans[1:]))
	assertLifecycleResult(t, waitLifecycleResult(t, logged))

	transport := logbrew.NewRecordingTransport([]any{logbrew.NetworkError("synthetic delivery failure")})
	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}

	if len(transport.SentBodies) != 2 || !bytes.Equal(transport.SentBodies[0], transport.SentBodies[1]) {
		t.Fatal("delivery retry changed the exported batch or event IDs")
	}

	assertLifecycleDelivered(t, transport.LastBody(), spans, 8)
	assertLifecycleRetainedFailure(t, client, exporter)
}

func TestSpanExporterCancelledExportWaitingForActiveExport(t *testing.T) {
	t.Parallel()

	client := newLifecycleClient(t)
	spans := lifecycleSpans(t)
	exporter := newLifecycleExporter(t, client, lifecycleConfig())
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), spans[:1]))

	started, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()

	active := gatedLifecycleSpan{ReadOnlySpan: spans[1], started: started, release: release}
	exported := make(chan error, 1)
	go func() { exported <- exporter.ExportSpans(t.Context(), []sdktrace.ReadOnlySpan{active}) }()
	waitLifecycleSignal(t, started)

	logged := writeLifecycleLogs(t.Context(), client, active.SpanContext(), 8)
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()

	if err := exporter.ExportSpans(ctx, spans[2:]); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("waiting export ignored its context: %v", err)
	}

	unblock()
	assertLifecycleResult(t, waitLifecycleResult(t, exported))
	assertLifecycleResult(t, waitLifecycleResult(t, logged))
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), spans[2:]))

	payload, events := lifecycleEvents(t, client)
	assertLifecycleEvents(t, events, spans, 8)
	assertLifecyclePrivacy(t, payload)
}

func assertLifecycleRetainedFailure(
	t *testing.T,
	client *logbrew.Client,
	exporter *logbrewotel.SpanExporter,
) {
	t.Helper()

	span := lifecycleSpans(t)[0]
	assertLifecycleResult(t, exporter.ExportSpans(t.Context(), []sdktrace.ReadOnlySpan{span}))
	assertLifecycleResult(t, writeLifecycleLog(t.Context(), client, span.SpanContext(), "failed_batch"))
	transport := logbrew.NewRecordingTransport([]any{503, 503, 503, 202, 202})
	if _, err := client.Flush(transport); err == nil {
		t.Fatal("failed delivery unexpectedly succeeded")
	}

	if client.PendingEvents() != 2 {
		t.Fatal("failed delivery lost the queued event")
	}

	assertLifecycleDelivered(t, transport.LastBody(), []sdktrace.ReadOnlySpan{span}, 1)

	assertLifecycleResult(t, exporter.Shutdown(t.Context()))
	assertLifecycleResult(t, writeLifecycleLog(t.Context(), client, span.SpanContext(), "later_batch"))
	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}

	if len(transport.SentBodies) != 4 {
		t.Fatalf("unexpected delivery attempts: %d", len(transport.SentBodies))
	}

	for _, body := range transport.SentBodies[1:] {
		if !bytes.Equal(body, transport.SentBodies[0]) {
			t.Fatal("failed snapshot changed across delivery retry")
		}
	}

	if client.PendingEvents() != 1 {
		t.Fatal("retry removed a log captured after the failed snapshot")
	}

	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}

	if client.PendingEvents() != 0 {
		t.Fatal("later log did not reach the app-owned transport")
	}

	assertLifecycleResult(t, writeLifecycleLog(t.Context(), client, span.SpanContext(), "still_open"))
}
