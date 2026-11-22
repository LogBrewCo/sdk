//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd

package logbrew

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
)

// failOnce fails the next save that reaches point, then lets every later save through.
// With pass set, it only runs before and lets that save continue.
type failOnce struct {
	mu     sync.Mutex
	point  string
	armed  bool
	pass   bool
	before func(directory string)
}

func armSaveFailure(t *testing.T, client *Client, point string) *failOnce {
	t.Helper()
	files, ok := client.persistent.files.(*unixPersistentFiles)
	if !ok {
		t.Fatal("persistent client has no file store")
	}
	failure := &failOnce{point: point}
	files.fail = func(reached string) error {
		failure.mu.Lock()
		defer failure.mu.Unlock()
		if !failure.armed || reached != failure.point {
			return nil
		}
		failure.armed = false
		if failure.before != nil {
			failure.before(files.directory)
		}
		if failure.pass {
			return nil
		}
		return errors.New("injected save failure")
	}
	return failure
}

func (f *failOnce) arm() {
	f.mu.Lock()
	f.armed = true
	f.mu.Unlock()
}

// armingTransport accepts every request and arms a save failure after the first one.
type armingTransport struct {
	*lifecycleTransport
	failure *failOnce
}

func (t armingTransport) Send(endpoint string, body []byte) (*TransportResponse, error) {
	response, err := t.lifecycleTransport.Send(endpoint, body)
	if len(t.bodiesSnapshot()) == 1 {
		t.failure.arm()
	}
	return response, err
}

func deliveredEventIDs(t *testing.T, transport *lifecycleTransport) []string {
	t.Helper()
	var ids []string
	for _, body := range transport.bodiesSnapshot() {
		var batch struct {
			Events []struct {
				ID string `json:"id"`
			} `json:"events"`
		}
		if err := json.Unmarshal(body, &batch); err != nil {
			t.Fatal(err)
		}
		for _, event := range batch.Events {
			ids = append(ids, event.ID)
		}
	}
	return ids
}

func captureTestLog(client *Client, id string) error {
	return client.Log(id, "2026-06-02T10:00:00Z", LogAttributes{Message: "queued", Level: "info"})
}

func assertNoStoredEvents(t *testing.T, client *Client, directory string, key []byte) {
	t.Helper()
	stopPersistentClientWithoutFlush(t, client)
	restarted := newPersistentTestClient(t, directory, key, newLifecycleTransport())
	defer stopPersistentClientWithoutFlush(t, restarted)
	if len(restarted.events) != 0 || restarted.pendingBody != nil {
		t.Fatalf("restart found undelivered state: %d events, pending %t", len(restarted.events), restarted.pendingBody != nil)
	}
}

func TestPersistentClientKeepsDeliveringAfterAFailedCaptureSave(t *testing.T) {
	cases := []struct {
		point     string
		committed bool
	}{
		{point: "after_temp_sync", committed: false},
		{point: "after_intent_sync", committed: true},
		{point: "after_rename", committed: true},
	}
	for _, current := range cases {
		t.Run(current.point, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "delivery")
			key := persistenceTestKey(0x52)
			transport := newLifecycleTransport(202)
			client := newPersistentTestClient(t, directory, key, transport)
			armSaveFailure(t, client, current.point).arm()

			err := captureTestLog(client, "evt_interrupted")
			want := []string{"evt_after_failure"}
			if current.committed {
				if err != nil {
					t.Fatalf("a save that committed failed the capture: %v", err)
				}
				want = []string{"evt_interrupted", "evt_after_failure"}
			} else {
				assertSDKErrorCode(t, err, "persistence_io_error")
			}
			if err := captureTestLog(client, "evt_after_failure"); err != nil {
				t.Fatalf("capture after 1 failed save: %v", err)
			}
			if _, err := client.Flush(transport); err != nil {
				t.Fatalf("flush after 1 failed save: %v", err)
			}
			if got := deliveredEventIDs(t, transport); !slices.Equal(got, want) {
				t.Fatalf("delivered %v, want %v once each", got, want)
			}
			assertNoStoredEvents(t, client, directory, key)
		})
	}
}

func TestPersistentClientRetriesAfterAFailedRequestSave(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x53)
	transport := newLifecycleTransport(202)
	client := newPersistentTestClient(t, directory, key, transport)
	if err := captureTestLog(client, "evt_queued"); err != nil {
		t.Fatal(err)
	}
	armSaveFailure(t, client, "after_temp_sync").arm()

	_, err := client.Flush(transport)
	assertSDKErrorCode(t, err, "persistence_io_error")
	if health := client.DeliveryHealth(); health.State == DeliveryStatePaused {
		t.Fatalf("1 failed save paused delivery: %#v", health)
	}
	if sent := len(transport.bodiesSnapshot()); sent != 0 {
		t.Fatalf("sent %d requests whose bytes were never saved", sent)
	}
	if _, err := client.Flush(transport); err != nil {
		t.Fatalf("retry after 1 failed save: %v", err)
	}
	if got := deliveredEventIDs(t, transport); !slices.Equal(got, []string{"evt_queued"}) {
		t.Fatalf("delivered %v, want evt_queued once", got)
	}
	assertNoStoredEvents(t, client, directory, key)
}

func TestPersistentClientSavesAcceptedRequestWithoutResending(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	key := persistenceTestKey(0x54)
	inner := newLifecycleTransport(202, 202)
	client := newPersistentTestClient(t, directory, key, inner)
	transport := armingTransport{lifecycleTransport: inner, failure: armSaveFailure(t, client, "after_temp_sync")}
	if err := captureTestLog(client, "evt_accepted"); err != nil {
		t.Fatal(err)
	}

	_, err := client.Flush(transport)
	assertSDKErrorCode(t, err, "persistence_io_error")
	if health := client.DeliveryHealth(); health.State == DeliveryStatePaused {
		t.Fatalf("1 failed save paused delivery: %#v", health)
	}
	if err := captureTestLog(client, "evt_next"); err != nil {
		t.Fatalf("capture after 1 failed save: %v", err)
	}
	if _, err := client.Flush(transport); err != nil {
		t.Fatalf("retry after 1 failed save: %v", err)
	}
	if got := deliveredEventIDs(t, inner); !slices.Equal(got, []string{"evt_accepted", "evt_next"}) {
		t.Fatalf("delivered %v, want each event once", got)
	}
	if health := client.DeliveryHealth(); health.AcceptedEvents != 2 {
		t.Fatalf("accepted %d events, want 2", health.AcceptedEvents)
	}
	assertNoStoredEvents(t, client, directory, key)
}

func TestPersistentClientStopsWhenAFailedSaveCannotBeConfirmed(t *testing.T) {
	cases := []struct {
		name   string
		point  string
		change func(directory string) error
	}{
		{name: "changed_temp", point: "after_intent_sync", change: func(directory string) error {
			return os.WriteFile(filepath.Join(directory, persistentTempFile), []byte("changed"), 0o600)
		}},
		{name: "changed_queue", point: "after_temp_sync", change: func(directory string) error {
			return os.WriteFile(filepath.Join(directory, persistentQueueFile), []byte("changed"), 0o600)
		}},
		{name: "missing_queue", point: "after_temp_sync", change: func(directory string) error {
			return os.Remove(filepath.Join(directory, persistentQueueFile))
		}},
	}
	for _, current := range cases {
		t.Run(current.name, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "delivery")
			transport := newLifecycleTransport(202)
			client := newPersistentTestClient(t, directory, persistenceTestKey(0x55), transport)
			failure := armSaveFailure(t, client, current.point)
			failure.before = func(directory string) {
				if err := current.change(directory); err != nil {
					t.Error(err)
				}
			}
			failure.arm()

			assertSDKErrorCode(t, captureTestLog(client, "evt_unconfirmed"), "persistence_commit_error")
			assertSDKErrorCode(t, captureTestLog(client, "evt_after_unconfirmed"), "persistence_commit_error")
			_, err := client.Flush(transport)
			assertSDKErrorCode(t, err, "persistence_commit_error")
			if sent := len(transport.bodiesSnapshot()); sent != 0 {
				t.Fatalf("sent %d requests from unconfirmed state", sent)
			}
			stopPersistentClientWithoutFlush(t, client)
		})
	}
}

func TestPersistentClientStaysStoppedAfterAnIntegrityFailure(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	transport := newLifecycleTransport(202)
	client := newPersistentTestClient(t, directory, persistenceTestKey(0x56), transport)
	if err := captureTestLog(client, "evt_stored"); err != nil {
		t.Fatal(err)
	}
	queuePath := filepath.Join(directory, persistentQueueFile)
	original, err := os.ReadFile(queuePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(queuePath, append([]byte(nil), persistenceEnvelopeMagic...), 0o600); err != nil {
		t.Fatal(err)
	}
	assertSDKErrorCode(t, captureTestLog(client, "evt_rejected"), "persistence_integrity_error")
	if err := os.WriteFile(queuePath, original, 0o600); err != nil {
		t.Fatal(err)
	}
	assertSDKErrorCode(t, captureTestLog(client, "evt_after_original_bytes"), "persistence_integrity_error")
	_, err = client.Flush(transport)
	assertSDKErrorCode(t, err, "persistence_integrity_error")
	if sent := len(transport.bodiesSnapshot()); sent != 0 {
		t.Fatalf("sent %d requests after an integrity failure", sent)
	}
	stopPersistentClientWithoutFlush(t, client)
}

func TestPersistentClientStopsWhenTheQueueChangesDuringASave(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	transport := newLifecycleTransport(202)
	client := newPersistentTestClient(t, directory, persistenceTestKey(0x57), transport)
	failure := armSaveFailure(t, client, "after_intent_sync")
	failure.pass = true
	failure.before = func(directory string) {
		if err := os.WriteFile(filepath.Join(directory, persistentQueueFile), []byte("changed"), 0o600); err != nil {
			t.Error(err)
		}
	}
	failure.arm()

	assertSDKErrorCode(t, captureTestLog(client, "evt_rejected"), "persistence_integrity_error")
	assertSDKErrorCode(t, captureTestLog(client, "evt_after_rejected"), "persistence_integrity_error")
	if sent := len(transport.bodiesSnapshot()); sent != 0 {
		t.Fatalf("sent %d requests after an integrity failure", sent)
	}
	stopPersistentClientWithoutFlush(t, client)
}
