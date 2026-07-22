package logbrew

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type lifecycleTransport struct {
	mu        sync.Mutex
	responses []any
	bodies    [][]byte
	sent      chan struct{}
	block     <-chan struct{}
	active    int
	maxActive int
}

func newLifecycleTransport(responses ...any) *lifecycleTransport {
	return &lifecycleTransport{
		responses: append([]any(nil), responses...),
		sent:      make(chan struct{}, 32),
	}
}

func (t *lifecycleTransport) Send(_ string, body []byte) (*TransportResponse, error) {
	t.mu.Lock()
	t.active++
	if t.active > t.maxActive {
		t.maxActive = t.active
	}
	t.bodies = append(t.bodies, append([]byte(nil), body...))
	var response any = 202
	if len(t.responses) > 0 {
		response = t.responses[0]
		t.responses = t.responses[1:]
	}
	t.mu.Unlock()

	t.sent <- struct{}{}
	if t.block != nil {
		<-t.block
	}
	t.mu.Lock()
	t.active--
	t.mu.Unlock()
	if err, ok := response.(error); ok {
		return nil, err
	}
	return &TransportResponse{StatusCode: response.(int), Attempts: 1}, nil
}

func (t *lifecycleTransport) bodiesSnapshot() [][]byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	bodies := make([][]byte, len(t.bodies))
	for index := range t.bodies {
		bodies[index] = append([]byte(nil), t.bodies[index]...)
	}
	return bodies
}

func (t *lifecycleTransport) maxConcurrentSends() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.maxActive
}

func (t *lifecycleTransport) waitForSends(testingT *testing.T, count int) {
	testingT.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for index := 0; index < count; index++ {
		select {
		case <-t.sent:
		case <-deadline.C:
			testingT.Fatalf("timed out waiting for %d transport sends", count)
		}
	}
}

func newLifecycleClient(testingT *testing.T, automatic *AutomaticDeliveryConfig) *Client {
	testingT.Helper()
	config := Config{
		APIKey:       "LOGBREW_API_KEY",
		SDKName:      "logbrew-go-lifecycle",
		SDKVersion:   "0.1.0",
		MaxRetries:   1,
		MaxQueueSize: 8,
	}
	var client *Client
	var err error
	if automatic == nil {
		client, err = NewClient(config)
	} else {
		client, err = NewAutomaticClient(config, *automatic)
	}
	if err != nil {
		testingT.Fatal(err)
	}
	return client
}

func queueLifecycleLog(testingT *testing.T, client *Client, id string) {
	testingT.Helper()
	if err := client.Log(id, "2026-06-02T10:00:03Z", LogAttributes{Message: "queued", Level: "info"}); err != nil {
		testingT.Fatal(err)
	}
}

func TestManualClientRemainsManual(t *testing.T) {
	client := newLifecycleClient(t, nil)
	queueLifecycleLog(t, client, "evt_manual_001")
	time.Sleep(20 * time.Millisecond)

	health := client.DeliveryHealth()
	if health.State != DeliveryStateManual || health.PendingEvents != 1 || health.InFlight || health.WakePending {
		t.Fatalf("unexpected manual health: %#v", health)
	}
}

func TestManualEmptyFlushAndShutdownKeepNilTransportCompatibility(t *testing.T) {
	client := newLifecycleClient(t, nil)
	response, err := client.Flush(nil)
	if err != nil || response.StatusCode != 204 || response.Attempts != 0 {
		t.Fatalf("unexpected empty flush result: response=%#v err=%v", response, err)
	}

	response, err = client.Shutdown(nil)
	if err != nil || response.StatusCode != 204 || response.Attempts != 0 {
		t.Fatalf("unexpected empty shutdown result: response=%#v err=%v", response, err)
	}
	if health := client.DeliveryHealth(); health.State != DeliveryStateShutdown {
		t.Fatalf("unexpected empty shutdown health: %#v", health)
	}
}

func TestAutomaticDeliveryFlushesAtThreshold(t *testing.T) {
	transport := newLifecycleTransport(202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 2,
	})
	queueLifecycleLog(t, client, "evt_threshold_001")
	queueLifecycleLog(t, client, "evt_threshold_002")
	transport.waitForSends(t, 1)

	if pending := client.PendingEvents(); pending != 0 {
		t.Fatalf("expected automatic threshold flush, pending=%d", pending)
	}
	health := client.DeliveryHealth()
	if health.State != DeliveryStateRunning || health.LastOutcome != DeliveryOutcomeAccepted || health.AcceptedEvents != 2 {
		t.Fatalf("unexpected threshold health: %#v", health)
	}
}

func TestAutomaticDeliveryFlushesOnInterval(t *testing.T) {
	transport := newLifecycleTransport(202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  10 * time.Millisecond,
		FlushThreshold: 8,
	})
	queueLifecycleLog(t, client, "evt_interval_001")
	transport.waitForSends(t, 1)

	if pending := client.PendingEvents(); pending != 0 {
		t.Fatalf("expected automatic interval flush, pending=%d", pending)
	}
}

func TestAutomaticDeliveryRetainsLaterCaptureAndCoalescesOneWake(t *testing.T) {
	release := make(chan struct{})
	transport := newLifecycleTransport(202, 202)
	transport.block = release
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_prefix_001")
	transport.waitForSends(t, 1)

	queueLifecycleLog(t, client, "evt_later_002")
	queueLifecycleLog(t, client, "evt_later_003")
	health := client.DeliveryHealth()
	if !health.InFlight || !health.WakePending || health.PendingEvents != 3 {
		t.Fatalf("unexpected in-flight health: %#v", health)
	}
	close(release)
	transport.waitForSends(t, 1)
	waitForPendingEvents(t, client, 0)

	bodies := transport.bodiesSnapshot()
	if len(bodies) != 2 {
		t.Fatalf("expected one active and one coalesced flush, got %d", len(bodies))
	}
	if !bytes.Contains(bodies[0], []byte("evt_prefix_001")) || bytes.Contains(bodies[0], []byte("evt_later_002")) {
		t.Fatalf("first body did not freeze the accepted prefix: %s", bodies[0])
	}
	if !bytes.Contains(bodies[1], []byte("evt_later_002")) || !bytes.Contains(bodies[1], []byte("evt_later_003")) {
		t.Fatalf("later work missing from coalesced body: %s", bodies[1])
	}
	if transport.maxConcurrentSends() != 1 {
		t.Fatalf("expected serialized sends, max active=%d", transport.maxConcurrentSends())
	}
}

func TestAutomaticDeliveryRetriesFrozenPrefixAfterBoundedDelay(t *testing.T) {
	transport := newLifecycleTransport(503, 503, 202, 202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 20 * time.Millisecond,
		RetryMaxDelay:  20 * time.Millisecond,
	})
	client.automatic.jitter = func(delay time.Duration) time.Duration { return delay / 2 }
	queueLifecycleLog(t, client, "evt_retry_001")
	transport.waitForSends(t, 2)

	select {
	case <-transport.sent:
		t.Fatal("retry ignored the configured lower delay bound")
	case <-time.After(5 * time.Millisecond):
	}
	queueLifecycleLog(t, client, "evt_retry_later_002")
	transport.waitForSends(t, 2)
	waitForPendingEvents(t, client, 0)

	bodies := transport.bodiesSnapshot()
	if len(bodies) != 4 || !bytes.Equal(bodies[0], bodies[1]) || !bytes.Equal(bodies[1], bodies[2]) {
		t.Fatal("retry attempts did not preserve the exact failed body")
	}
	if bytes.Contains(bodies[2], []byte("evt_retry_later_002")) || !bytes.Contains(bodies[3], []byte("evt_retry_later_002")) {
		t.Fatal("later work was not retained outside the failed prefix")
	}
	health := client.DeliveryHealth()
	if health.RetrySchedules != 1 || health.FailedFlushes != 1 || health.AcceptedEvents != 2 {
		t.Fatalf("unexpected retry health: %#v", health)
	}
}

func TestAutomaticDeliveryPausesTerminalResponsesUntilResume(t *testing.T) {
	for _, current := range []struct {
		name    string
		status  int
		outcome string
	}{
		{name: "authentication", status: 401, outcome: DeliveryOutcomeAuthenticationPause},
		{name: "quota", status: 429, outcome: DeliveryOutcomeQuotaPause},
		{name: "nonretryable", status: 400, outcome: DeliveryOutcomeNonRetryablePause},
	} {
		t.Run(current.name, func(t *testing.T) {
			transport := newLifecycleTransport(current.status, 202)
			client := newLifecycleClient(t, &AutomaticDeliveryConfig{
				Transport:      transport,
				FlushInterval:  time.Hour,
				FlushThreshold: 1,
			})
			queueLifecycleLog(t, client, "evt_pause_001")
			transport.waitForSends(t, 1)
			waitForState(t, client, DeliveryStatePaused)

			queueLifecycleLog(t, client, "evt_pause_002")
			select {
			case <-transport.sent:
				t.Fatal("paused client sent before explicit resume")
			case <-time.After(15 * time.Millisecond):
			}
			health := client.DeliveryHealth()
			if health.LastOutcome != current.outcome || health.PendingEvents != 2 {
				t.Fatalf("unexpected paused health: %#v", health)
			}

			if err := client.ResumeDelivery(); err != nil {
				t.Fatal(err)
			}
			transport.waitForSends(t, 1)
			waitForPendingEvents(t, client, 0)
		})
	}
}

func TestAutomaticDeliveryDiscardsPrePauseWakeUntilExplicitResume(t *testing.T) {
	release := make(chan struct{})
	transport := newLifecycleTransport(401, 202)
	transport.block = release
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_pause_prefix_001")
	transport.waitForSends(t, 1)
	queueLifecycleLog(t, client, "evt_pause_later_002")
	close(release)
	waitForState(t, client, DeliveryStatePaused)

	select {
	case <-transport.sent:
		t.Fatal("a wake queued before the terminal response bypassed the pause")
	case <-time.After(20 * time.Millisecond):
	}
	if err := client.ResumeDelivery(); err != nil {
		t.Fatal(err)
	}
	transport.waitForSends(t, 1)
	waitForPendingEvents(t, client, 0)
}

func TestAutomaticDeliveryPausesNonRetryableTransportError(t *testing.T) {
	transport := newLifecycleTransport(&TransportError{Code: "delivery_rejected", Message: "private transport detail", Retryable: false}, 202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  10 * time.Millisecond,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_transport_pause_001")
	transport.waitForSends(t, 1)
	waitForState(t, client, DeliveryStatePaused)

	select {
	case <-transport.sent:
		t.Fatal("non-retryable transport failure was retried automatically")
	case <-time.After(25 * time.Millisecond):
	}
	if health := client.DeliveryHealth(); health.LastOutcome != DeliveryOutcomeNonRetryablePause {
		t.Fatalf("unexpected transport pause health: %#v", health)
	}
}

func TestManualFlushTerminalPauseStopsAutomaticTimer(t *testing.T) {
	ownedTransport := newLifecycleTransport(202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      ownedTransport,
		FlushInterval:  20 * time.Millisecond,
		FlushThreshold: 8,
	})
	queueLifecycleLog(t, client, "evt_manual_pause_001")
	time.Sleep(5 * time.Millisecond)

	if _, err := client.Flush(newLifecycleTransport(401)); err == nil {
		t.Fatal("expected caller-triggered flush to pause automatic delivery")
	}
	waitForState(t, client, DeliveryStatePaused)
	select {
	case <-ownedTransport.sent:
		t.Fatal("automatic timer bypassed the caller-triggered terminal pause")
	case <-time.After(35 * time.Millisecond):
	}

	if err := client.ResumeDelivery(); err != nil {
		t.Fatal(err)
	}
	ownedTransport.waitForSends(t, 1)
	waitForPendingEvents(t, client, 0)
}

func TestManualFlushAcceptsOnlySnapshotPrefixDuringCapture(t *testing.T) {
	release := make(chan struct{})
	transport := newLifecycleTransport(202)
	transport.block = release
	client := newLifecycleClient(t, nil)
	client.events = make([]Event, 0, client.maxQueueSize)
	queueLifecycleLog(t, client, "evt_manual_prefix_001")
	client.mu.Lock()
	queueBacking := client.events[:cap(client.events)]
	client.mu.Unlock()

	result := make(chan error, 1)
	go func() {
		_, err := client.Flush(transport)
		result <- err
	}()
	transport.waitForSends(t, 1)
	queueLifecycleLog(t, client, "evt_manual_later_002")
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}

	if client.PendingEvents() != 1 {
		t.Fatalf("expected later capture to remain queued, got %d", client.PendingEvents())
	}
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(payload, "evt_manual_prefix_001") || !strings.Contains(payload, "evt_manual_later_002") {
		t.Fatalf("manual prefix acknowledgement was incorrect: %s", payload)
	}
	if queueBacking[0].ID != "evt_manual_later_002" || queueBacking[1].ID != "" || queueBacking[1].Attributes != nil {
		t.Fatal("accepted event content remained referenced after queue compaction")
	}
}

func TestAutomaticShutdownSerializesInFlightDrainAndRejectsRaceCapture(t *testing.T) {
	release := make(chan struct{})
	transport := newLifecycleTransport(202)
	transport.block = release
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_shutdown_race_001")
	transport.waitForSends(t, 1)

	shutdownResult := make(chan error, 1)
	go func() {
		_, err := client.Shutdown(nil)
		shutdownResult <- err
	}()
	waitForState(t, client, DeliveryStateShuttingDown)
	if err := client.Log("evt_shutdown_race_late", "2026-06-02T10:00:04Z", LogAttributes{Message: "late", Level: "info"}); err == nil {
		t.Fatal("capture mutated the queue after shutdown started")
	}
	close(release)
	if err := <-shutdownResult; err != nil {
		t.Fatal(err)
	}

	health := client.DeliveryHealth()
	if health.State != DeliveryStateShutdown || health.PendingEvents != 0 || health.InFlight || health.WakePending {
		t.Fatalf("unexpected shutdown health: %#v", health)
	}
	if transport.maxConcurrentSends() != 1 {
		t.Fatalf("shutdown created concurrent sends: %d", transport.maxConcurrentSends())
	}
}

func TestAutomaticDeliveryPausesUnknownTransportFailure(t *testing.T) {
	transport := newLifecycleTransport(errors.New("private transport failure"))
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  10 * time.Millisecond,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_unknown_pause_001")
	transport.waitForSends(t, 1)
	waitForState(t, client, DeliveryStatePaused)
}

func TestAutomaticShutdownFailureRejectsCaptureAndCanRetry(t *testing.T) {
	transport := newLifecycleTransport(503, 503, 202)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 8,
	})
	queueLifecycleLog(t, client, "evt_shutdown_001")

	if _, err := client.Shutdown(nil); err == nil {
		t.Fatal("expected first shutdown to retain failed work")
	}
	if err := client.Log("evt_shutdown_late", "2026-06-02T10:00:04Z", LogAttributes{Message: "late", Level: "info"}); err == nil {
		t.Fatal("expected post-shutdown mutation to be rejected")
	}
	health := client.DeliveryHealth()
	if health.State != DeliveryStateShutdownFailed || health.PendingEvents != 1 {
		t.Fatalf("unexpected failed shutdown health: %#v", health)
	}

	if _, err := client.Shutdown(nil); err != nil {
		t.Fatal(err)
	}
	if health := client.DeliveryHealth(); health.State != DeliveryStateShutdown || health.PendingEvents != 0 {
		t.Fatalf("unexpected recovered shutdown health: %#v", health)
	}
}

func TestDeliveryHealthJSONIsFixedAndContentFree(t *testing.T) {
	transport := newLifecycleTransport(401)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_private_identifier")
	transport.waitForSends(t, 1)
	waitForState(t, client, DeliveryStatePaused)

	encoded, err := json.Marshal(client.DeliveryHealth())
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{
		"LOGBREW_API_KEY", "evt_private_identifier", "queued", "authorization",
		"endpoint", "header", "host", "path", "payload", "error", "message",
	} {
		if strings.Contains(strings.ToLower(string(encoded)), strings.ToLower(forbidden)) {
			t.Fatalf("health leaked forbidden content %q: %s", forbidden, encoded)
		}
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 17 {
		t.Fatalf("unexpected health field set: %#v", fields)
	}
}

func waitForPendingEvents(t *testing.T, client *Client, expected int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if client.PendingEvents() == expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for pending=%d, got %d", expected, client.PendingEvents())
}

func waitForState(t *testing.T, client *Client, expected string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if client.DeliveryHealth().State == expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for state=%s, got %#v", expected, client.DeliveryHealth())
}
