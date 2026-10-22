package logbrew

import (
	"encoding/json"
	"reflect"
	"testing"
)

const evictionTimestamp = "2026-06-02T10:00:00Z"

func evictionClient(t *testing.T, maxQueueSize int, drops *[]EventDrop) *Client {
	t.Helper()
	client, err := NewClient(Config{
		APIKey:         "LOGBREW_API_KEY",
		SDKName:        "logbrew-go",
		SDKVersion:     "0.1.0",
		MaxQueueSize:   maxQueueSize,
		MaxRetries:     -1,
		OnEventDropped: func(drop EventDrop) { *drops = append(*drops, drop) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func evictionLog(t *testing.T, client *Client, id string) {
	t.Helper()
	if err := client.Log(id, evictionTimestamp, LogAttributes{Message: "queued", Level: "info"}); err != nil {
		t.Fatal(err)
	}
}

func evictionFatal(t *testing.T, client *Client, id string) {
	t.Helper()
	if err := client.Issue(id, evictionTimestamp, IssueAttributes{Title: "App crashed", Level: "fatal"}); err != nil {
		t.Fatal(err)
	}
}

func queuedEventIDs(t *testing.T, client *Client) []string {
	t.Helper()
	preview, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	var batch struct {
		Events []struct {
			ID string `json:"id"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(preview), &batch); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(batch.Events))
	for _, event := range batch.Events {
		ids = append(ids, event.ID)
	}
	return ids
}

func TestFatalAtFullQueueEvictsOldestNonFatalEvent(t *testing.T) {
	var drops []EventDrop
	client := evictionClient(t, 3, &drops)
	evictionLog(t, client, "evt_log_001")
	evictionFatal(t, client, "evt_fatal_001")
	evictionLog(t, client, "evt_log_002")

	evictionFatal(t, client, "evt_fatal_002")

	if got, want := queuedEventIDs(t, client), []string{"evt_fatal_001", "evt_log_002", "evt_fatal_002"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queued ids = %v, want %v", got, want)
	}
	want := []EventDrop{{EventID: "evt_log_001", EventType: "log", Reason: "evicted_for_fatal", DroppedEvents: 1}}
	if !reflect.DeepEqual(drops, want) {
		t.Fatalf("drops = %#v, want %#v", drops, want)
	}
}

func TestFatalNeverEvictsCrashReportsOrTheBodyBeingRetried(t *testing.T) {
	var drops []EventDrop
	client := evictionClient(t, 2, &drops)
	evictionLog(t, client, "evt_log_001")
	evictionLog(t, client, "evt_log_002")
	if _, err := client.Flush(NewRecordingTransport([]any{NetworkError("offline")})); err == nil {
		t.Fatal("flush should fail")
	}
	evictionFatal(t, client, "evt_fatal_001")

	fatalOnly := evictionClient(t, 1, &drops)
	evictionFatal(t, fatalOnly, "evt_fatal_002")
	evictionFatal(t, fatalOnly, "evt_fatal_003")

	if got, want := queuedEventIDs(t, client), []string{"evt_log_001", "evt_log_002"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("queued ids = %v, want %v", got, want)
	}
	if got, want := queuedEventIDs(t, fatalOnly), []string{"evt_fatal_002"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("fatal-only ids = %v, want %v", got, want)
	}
	for _, drop := range drops {
		if drop.Reason != "queue_overflow" {
			t.Fatalf("unexpected drop %#v", drop)
		}
	}
	if len(drops) != 2 {
		t.Fatalf("drops = %#v", drops)
	}
}
