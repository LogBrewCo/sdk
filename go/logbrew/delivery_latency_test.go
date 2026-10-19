package logbrew

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func newDefaultIntervalClient(testingT *testing.T, transport *lifecycleTransport) *Client {
	testingT.Helper()
	client, err := NewAutomaticClient(Config{
		APIKey:       "LOGBREW_API_KEY",
		SDKName:      "logbrew-go-latency",
		SDKVersion:   "0.1.0",
		MaxQueueSize: 1000,
	}, AutomaticDeliveryConfig{Transport: transport})
	if err != nil {
		testingT.Fatal(err)
	}
	return client
}

func waitForFirstSend(transport *lifecycleTransport, limit time.Duration) bool {
	select {
	case <-transport.sent:
		return true
	case <-time.After(limit):
		return false
	}
}

func TestDefaultIntervalDeliversASingleEventWithinAboutOneSecond(t *testing.T) {
	transport := newLifecycleTransport()
	client := newDefaultIntervalClient(t, transport)
	defer func() { _, _ = client.Shutdown(transport) }()
	capturedAt := time.Now()
	queueLifecycleLog(t, client, "evt_latency_001")

	if !waitForFirstSend(transport, 1500*time.Millisecond) {
		t.Fatal("the default interval must deliver one event within 1.5 s")
	}
	if elapsed := time.Since(capturedAt); elapsed < 900*time.Millisecond {
		t.Fatalf("the first event should wait for its batch window, sent after %s", elapsed)
	}
}

func TestDefaultIntervalSendsABurstAsOneRequest(t *testing.T) {
	transport := newLifecycleTransport()
	client := newDefaultIntervalClient(t, transport)
	defer func() { _, _ = client.Shutdown(transport) }()
	for index := range 20 {
		queueLifecycleLog(t, client, fmt.Sprintf("evt_burst_%03d", index))
	}

	if !waitForFirstSend(transport, 1500*time.Millisecond) {
		t.Fatal("the burst was not delivered within 1.5 s")
	}
	var batch struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(transport.bodiesSnapshot()[0], &batch); err != nil {
		t.Fatal(err)
	}
	if len(batch.Events) != 20 {
		t.Fatalf("expected one request with 20 events, got %d", len(batch.Events))
	}
}
