package logbrew

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

const reportTestMaxBytes = 4 * 1024 * 1024

func reportRestartClient(t *testing.T, directory string, transport Transport) *Client {
	t.Helper()
	var drops []EventDrop
	return persistentEvictionClient(t, directory, 1, reportTestMaxBytes, transport, &drops)
}

func crashClient(t *testing.T, client *Client) {
	t.Helper()
	stopPersistentClientWithoutFlush(t, client)
}

func TestUnreportedDropCountsSurviveARestart(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	client := reportRestartClient(t, directory, newLifecycleTransport(202))
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_log_002")
	evictionFatal(t, client, "evt_fatal_001")
	crashClient(t, client)

	transport := AlwaysAcceptTransport()
	restarted := reportRestartClient(t, directory, newLifecycleTransport(202))
	if _, err := restarted.Flush(transport); err != nil {
		t.Fatal(err)
	}
	report := sentReport(t, transport.LastBody())
	if report == nil {
		t.Fatal("restart lost the unreported drop counts")
	}
	want := map[string]int{"evicted_for_fatal": 1, "queue_overflow": 1}
	if !reflect.DeepEqual(report.DroppedEvents, want) {
		t.Fatalf("dropped_events = %v, want %v", report.DroppedEvents, want)
	}
	evictionLog(t, restarted, "evt_log_003")
	if _, err := restarted.Flush(transport); err != nil {
		t.Fatal(err)
	}
	if report := sentReport(t, transport.LastBody()); report != nil {
		t.Fatalf("accepted counts were sent again: %#v", report)
	}
	crashClient(t, restarted)
	reopened := reportRestartClient(t, directory, newLifecycleTransport(202))
	defer crashClient(t, reopened)
	if reopened.persistent.queue.UnreportedDrops != nil || len(reopened.unreportedDrops) != 0 {
		t.Fatalf("a drained store keeps drop counts: %s", reopened.persistent.queue.UnreportedDrops)
	}
}

func TestAReportSentBeforeARestartKeepsItsIDAndLaterDropsGetANewOne(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	failed := newLifecycleTransport(503, 503, 503)
	client := reportRestartClient(t, directory, failed)
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_log_002")
	if _, err := client.Flush(nil); err == nil {
		t.Fatal("flush should fail")
	}
	evictionLog(t, client, "evt_log_003")
	crashClient(t, client)

	accepted := newLifecycleTransport(202, 202)
	restarted := reportRestartClient(t, directory, accepted)
	if _, err := restarted.Flush(nil); err != nil {
		t.Fatal(err)
	}
	evictionLog(t, restarted, "evt_log_004")
	if _, err := restarted.Flush(nil); err != nil {
		t.Fatal(err)
	}
	sentBefore := sentReport(t, failed.bodiesSnapshot()[0])
	resent := sentReport(t, accepted.bodiesSnapshot()[0])
	if sentBefore == nil || !reflect.DeepEqual(resent, sentBefore) {
		t.Fatalf("resent report = %#v, want %#v", resent, sentBefore)
	}
	later := sentReport(t, accepted.bodiesSnapshot()[1])
	if later == nil || later.ReportID == resent.ReportID ||
		!reflect.DeepEqual(later.DroppedEvents, map[string]int{"queue_overflow": 1}) {
		t.Fatalf("later report = %#v, want a new ID with the drops after the first request", later)
	}
	crashClient(t, restarted)
}

func TestADropBurstSavesAtMostOnceASecondAndShutdownSavesTheRest(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	client := reportRestartClient(t, directory, newLifecycleTransport(202))
	now := time.Unix(1_000, 0)
	client.reportClock = func() time.Time { return now }
	savedCounts := func() map[string]int {
		return decodeSavedCounts(t, client.persistent.queue.UnreportedDrops)
	}
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_dropped_1")
	if got := savedCounts(); !reflect.DeepEqual(got, map[string]int{"queue_overflow": 1}) {
		t.Fatalf("a new reason saves at once, saved %v", got)
	}
	now = now.Add(200 * time.Millisecond)
	evictionLog(t, client, "evt_dropped_2")
	evictionLog(t, client, "evt_dropped_3")
	if got := savedCounts(); !reflect.DeepEqual(got, map[string]int{"queue_overflow": 1}) {
		t.Fatalf("a burst saves at most once a second, saved %v", got)
	}
	now = now.Add(time.Second)
	evictionLog(t, client, "evt_dropped_4")
	if got := savedCounts(); !reflect.DeepEqual(got, map[string]int{"queue_overflow": 4}) {
		t.Fatalf("a later drop saves the burst, saved %v", got)
	}
	evictionLog(t, client, "evt_dropped_5")
	if got := savedCounts(); !reflect.DeepEqual(got, map[string]int{"queue_overflow": 4}) {
		t.Fatalf("saved %v inside the interval", got)
	}
	if _, err := client.Shutdown(newLifecycleTransport(400)); err == nil {
		t.Fatal("shutdown should fail")
	}
	crashClient(t, client)

	accepted := newLifecycleTransport(202)
	restarted := reportRestartClient(t, directory, accepted)
	defer crashClient(t, restarted)
	if _, err := restarted.Flush(nil); err != nil {
		t.Fatal(err)
	}
	if report := sentReport(t, accepted.bodiesSnapshot()[0]); report == nil || report.DroppedEvents["queue_overflow"] != 5 {
		t.Fatalf("restart restored report %#v, want 5 queue_overflow drops", report)
	}
}

func TestUnreadableSavedDropCountsAreIgnored(t *testing.T) {
	for name, saved := range map[string]string{
		"invalid entries":  `{"Not-A-Reason":1,"queue_overflow":"3","event_too_large":0,"evicted_for_fatal":2,"queue_bytes_overflow":1.5}`,
		"not an object":    `[1,2]`,
		"too many reasons": tooManyReasons(),
	} {
		t.Run(name, func(t *testing.T) {
			directory := filepath.Join(t.TempDir(), "delivery")
			client := reportRestartClient(t, directory, newLifecycleTransport(202))
			next := clonePersistedQueue(client.persistent.queue)
			next.UnreportedDrops = json.RawMessage(saved)
			if err := client.persistent.writeQueue(next); err != nil {
				t.Fatal(err)
			}
			crashClient(t, client)

			restarted := reportRestartClient(t, directory, newLifecycleTransport(202))
			defer crashClient(t, restarted)
			want := map[string]int{}
			switch name {
			case "invalid entries":
				want["evicted_for_fatal"] = 2
			case "too many reasons":
				for index := 0; index < maxClientReportReasons; index++ {
					want[reasonName(index)] = 1
				}
			}
			if !reflect.DeepEqual(restarted.unreportedDrops, want) {
				t.Fatalf("restored %v, want %v", restarted.unreportedDrops, want)
			}
		})
	}
}

func TestAFailedDropCountSaveNeverFailsCapture(t *testing.T) {
	client := reportRestartClient(t, filepath.Join(t.TempDir(), "delivery"), newLifecycleTransport(202))
	evictionLog(t, client, "evt_log_001")
	client.persistent.failed = errors.New("storage unavailable")
	if err := client.Log("evt_log_002", "2026-06-02T10:00:00Z", LogAttributes{Message: "dropped", Level: "info"}); err != nil {
		t.Fatalf("capture failed after a failed save: %v", err)
	}
	if client.DroppedEvents() != 1 || client.unreportedDrops["queue_overflow"] != 1 {
		t.Fatalf("drop was not counted in memory: %d, %v", client.DroppedEvents(), client.unreportedDrops)
	}
}

func reasonName(index int) string {
	return "reason_" + string(rune('a'+index))
}

func tooManyReasons() string {
	counts := make(map[string]int)
	for index := 0; index < maxClientReportReasons+4; index++ {
		counts[reasonName(index)] = 1
	}
	encoded, _ := json.Marshal(counts)
	return string(encoded)
}

func decodeSavedCounts(t *testing.T, raw json.RawMessage) map[string]int {
	t.Helper()
	counts := make(map[string]int)
	if raw == nil {
		return counts
	}
	if err := json.Unmarshal(raw, &counts); err != nil {
		t.Fatal(err)
	}
	return counts
}

const reportHelperEnv = "LOGBREW_REPORT_HELPER_DIRECTORY"

// TestReportHelperProcess is the app that drops events and exits without
// cleanup. TestUnreportedDropCountsSurviveARestartInAnotherProcess starts it.
func TestReportHelperProcess(t *testing.T) {
	directory := os.Getenv(reportHelperEnv)
	if directory == "" {
		t.Skip("runs only as a child process")
	}
	client := reportRestartClient(t, directory, newLifecycleTransport(202))
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_log_002")
	os.Exit(0)
}

func TestUnreportedDropCountsSurviveARestartInAnotherProcess(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "delivery")
	command := exec.Command(os.Args[0], "-test.run=^TestReportHelperProcess$")
	command.Env = append(os.Environ(), reportHelperEnv+"="+directory)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("helper process failed: %v\n%s", err, output)
	}

	transport := newLifecycleTransport(202)
	restarted := reportRestartClient(t, directory, transport)
	defer crashClient(t, restarted)
	if _, err := restarted.Flush(nil); err != nil {
		t.Fatal(err)
	}
	report := sentReport(t, transport.bodiesSnapshot()[0])
	if report == nil || !reflect.DeepEqual(report.DroppedEvents, map[string]int{"queue_overflow": 1}) {
		t.Fatalf("restart in another process lost the drop counts: %#v", report)
	}
}
