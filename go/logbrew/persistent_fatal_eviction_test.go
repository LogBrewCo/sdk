package logbrew

import (
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func persistentEvictionClient(
	t *testing.T,
	directory string,
	maxQueueSize, maxStoredBytes int,
	transport Transport,
	drops *[]EventDrop,
) *Client {
	t.Helper()
	config := persistentTestConfig(directory, persistenceTestKey(0x51))
	config.MaxStoredBytes = maxStoredBytes
	client, err := NewPersistentAutomaticClient(
		Config{
			APIKey:                "LOGBREW_API_KEY",
			SDKName:               "logbrew-go-persistence",
			SDKVersion:            "0.1.0",
			MaxQueueSize:          maxQueueSize,
			DisableRuntimeContext: true,
			OnEventDropped:        func(drop EventDrop) { *drops = append(*drops, drop) },
		},
		AutomaticDeliveryConfig{Transport: transport, FlushInterval: time.Hour, FlushThreshold: maxQueueSize},
		config,
	)
	if err != nil {
		t.Fatal(err)
	}
	// Keep delivery manual so the test controls which events are in flight.
	stopPersistentAutomaticLoop(t, client)
	return client
}

func reopenedEventIDs(t *testing.T, client *Client, directory string, maxQueueSize, maxStoredBytes int) []string {
	t.Helper()
	stopPersistentClientWithoutFlush(t, client)
	var drops []EventDrop
	reopened := persistentEvictionClient(t, directory, maxQueueSize, maxStoredBytes, newLifecycleTransport(202), &drops)
	defer stopPersistentClientWithoutFlush(t, reopened)
	return queuedEventIDs(t, reopened)
}

func TestPersistentFatalAtFullQueueEvictsOldestNonCrashEventAcrossRestart(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	var drops []EventDrop
	client := persistentEvictionClient(t, directory, 3, 4*1024*1024, newLifecycleTransport(202), &drops)
	evictionLog(t, client, "evt_log_001")
	evictionFatal(t, client, "evt_fatal_001")
	evictionLog(t, client, "evt_log_002")

	evictionFatal(t, client, "evt_fatal_002")

	want := []EventDrop{{EventID: "evt_log_001", EventType: "log", Reason: "evicted_for_fatal", DroppedEvents: 1}}
	if !reflect.DeepEqual(drops, want) {
		t.Fatalf("drops = %#v, want %#v", drops, want)
	}
	if got := client.unreportedDrops["evicted_for_fatal"]; got != 1 {
		t.Fatalf("unreported evicted_for_fatal = %d, want 1", got)
	}
	got := reopenedEventIDs(t, client, directory, 3, 4*1024*1024)
	if want := []string{"evt_fatal_001", "evt_log_002", "evt_fatal_002"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids after restart = %v, want %v", got, want)
	}
}

func TestPersistentFatalAtByteLimitKeepsTheRetriedBodyAndEvictsUntilItFits(t *testing.T) {
	var probeDrops []EventDrop
	probe := persistentEvictionClient(t, filepath.Join(t.TempDir(), "probe"), 8, 4*1024*1024, newLifecycleTransport(202), &probeDrops)
	evictionLog(t, probe, "evt_log_001")
	evictionFatal(t, probe, "evt_fatal_001")
	logBytes, fatalBytes := len(probe.persistent.queue.Events[0]), len(probe.persistent.queue.Events[1])
	stopPersistentClientWithoutFlush(t, probe)
	if fatalBytes <= logBytes || fatalBytes > 2*logBytes {
		t.Fatalf("test needs a crash report between one and two log sizes: log %d, fatal %d", logBytes, fatalBytes)
	}

	directory := filepath.Join(t.TempDir(), "delivery")
	maxBytes := 4 * logBytes
	var drops []EventDrop
	client := persistentEvictionClient(t, directory, 8, maxBytes, newLifecycleTransport(503, 503, 503), &drops)
	evictionLog(t, client, "evt_log_001")
	if _, err := client.Flush(nil); err == nil {
		t.Fatal("flush should fail")
	}
	evictionLog(t, client, "evt_log_002")
	evictionLog(t, client, "evt_log_003")
	evictionLog(t, client, "evt_log_004")

	evictionFatal(t, client, "evt_fatal_001")

	if len(drops) != 2 || drops[0].EventID != "evt_log_002" || drops[1].EventID != "evt_log_003" ||
		drops[0].Reason != "evicted_for_fatal" || drops[1].Reason != "evicted_for_fatal" {
		t.Fatalf("drops = %#v", drops)
	}
	got := reopenedEventIDs(t, client, directory, 8, maxBytes)
	if want := []string{"evt_log_001", "evt_log_004", "evt_fatal_001"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("ids after restart = %v, want %v", got, want)
	}
}

func TestPersistentFatalIsDroppedWhenOnlyCrashReportsAreQueued(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	var drops []EventDrop
	client := persistentEvictionClient(t, directory, 1, 4*1024*1024, newLifecycleTransport(202), &drops)
	evictionFatal(t, client, "evt_fatal_001")

	evictionFatal(t, client, "evt_fatal_002")

	want := []EventDrop{{EventID: "evt_fatal_002", EventType: "issue", Reason: "queue_overflow", DroppedEvents: 1}}
	if !reflect.DeepEqual(drops, want) {
		t.Fatalf("drops = %#v, want %#v", drops, want)
	}
	if got := reopenedEventIDs(t, client, directory, 1, 4*1024*1024); !reflect.DeepEqual(got, []string{"evt_fatal_001"}) {
		t.Fatalf("ids after restart = %v", got)
	}
}
