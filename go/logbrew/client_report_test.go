package logbrew

import (
	"encoding/json"
	"reflect"
	"regexp"
	"testing"
)

var reportIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{16,64}$`)

type sentClientReport struct {
	ReportID      string         `json:"report_id"`
	DroppedEvents map[string]int `json:"dropped_events"`
}

func sentReport(t *testing.T, body []byte) *sentClientReport {
	t.Helper()
	var batch struct {
		ClientReport *sentClientReport `json:"client_report"`
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		t.Fatal(err)
	}
	if batch.ClientReport != nil && !reportIDPattern.MatchString(batch.ClientReport.ReportID) {
		t.Fatalf("report id %q does not match the schema", batch.ClientReport.ReportID)
	}
	return batch.ClientReport
}

func reportClient(t *testing.T, maxQueueSize int) *Client {
	t.Helper()
	client, err := NewClient(Config{
		APIKey:       "LOGBREW_API_KEY",
		SDKName:      "logbrew-go",
		SDKVersion:   "0.1.0",
		MaxQueueSize: maxQueueSize,
		MaxRetries:   1,
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestDroppedEventsRideInTheNextBatchAsAClientReport(t *testing.T) {
	client := reportClient(t, 1)
	evictionLog(t, client, "evt_log_001")
	evictionFatal(t, client, "evt_fatal_001")
	evictionLog(t, client, "evt_log_002")
	transport := AlwaysAcceptTransport()

	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}
	report := sentReport(t, transport.LastBody())
	if report == nil {
		t.Fatal("flush sent no client report")
	}
	want := map[string]int{"evicted_for_fatal": 1, "queue_overflow": 1}
	if !reflect.DeepEqual(report.DroppedEvents, want) {
		t.Fatalf("dropped_events = %v, want %v", report.DroppedEvents, want)
	}

	evictionLog(t, client, "evt_log_003")
	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}
	if report := sentReport(t, transport.LastBody()); report != nil {
		t.Fatalf("accepted report was sent again: %#v", report)
	}
	if got := client.DroppedEvents(); got != 2 {
		t.Fatalf("DroppedEvents() = %d, want 2", got)
	}
}

func TestResentClientReportKeepsItsIDAndLaterDropsWaitForANewID(t *testing.T) {
	client := reportClient(t, 1)
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_log_002")
	transport := NewRecordingTransport([]any{503, 503, 202})

	if _, err := client.Flush(transport); err == nil {
		t.Fatal("flush should fail")
	}
	evictionLog(t, client, "evt_log_003")
	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}
	if len(transport.SentBodies) != 3 {
		t.Fatalf("sent %d bodies, want 3", len(transport.SentBodies))
	}
	first := sentReport(t, transport.SentBodies[0])
	if first == nil {
		t.Fatal("failed flush sent no client report")
	}
	for _, body := range transport.SentBodies[1:] {
		resent := sentReport(t, body)
		if resent == nil || resent.ReportID != first.ReportID {
			t.Fatalf("resent report = %#v, want id %q", resent, first.ReportID)
		}
		if !reflect.DeepEqual(resent.DroppedEvents, map[string]int{"queue_overflow": 1}) {
			t.Fatalf("resent dropped_events = %v", resent.DroppedEvents)
		}
	}

	evictionLog(t, client, "evt_log_004")
	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}
	next := sentReport(t, transport.LastBody())
	if next == nil || next.ReportID == first.ReportID {
		t.Fatalf("drop during the failed send should use a new report id, got %#v", next)
	}
	if !reflect.DeepEqual(next.DroppedEvents, map[string]int{"queue_overflow": 1}) {
		t.Fatalf("next dropped_events = %v", next.DroppedEvents)
	}
}

func TestClientReportCountsStopAtTheSchemaMaximum(t *testing.T) {
	client := reportClient(t, 1)
	evictionLog(t, client, "evt_log_001")
	client.mu.Lock()
	client.unreportedDrops = map[string]int{eventDropReasonQueueOverflow: maxClientReportCount}
	client.mu.Unlock()
	evictionLog(t, client, "evt_log_002")
	transport := AlwaysAcceptTransport()

	if _, err := client.Flush(transport); err != nil {
		t.Fatal(err)
	}
	report := sentReport(t, transport.LastBody())
	if report == nil || report.DroppedEvents["queue_overflow"] != maxClientReportCount {
		t.Fatalf("report = %#v, want capped count", report)
	}
}
