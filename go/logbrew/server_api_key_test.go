package logbrew

import (
	"errors"
	"strings"
	"testing"
)

type keyRecordingTransport struct {
	apiKeys []string
}

func (t *keyRecordingTransport) Send(apiKey string, _ []byte) (*TransportResponse, error) {
	t.apiKeys = append(t.apiKeys, apiKey)
	return &TransportResponse{StatusCode: 202, Attempts: 1}, nil
}

func sentAPIKeys(t *testing.T, config Config) []string {
	t.Helper()
	client, err := NewClient(config)
	if err != nil {
		t.Fatalf("build client: %v", err)
	}
	if err := client.Log("evt_server_key_001", "2026-11-27T10:00:00Z", LogAttributes{Message: "first event", Level: "info"}); err != nil {
		t.Fatalf("log: %v", err)
	}
	transport := &keyRecordingTransport{}
	if _, err := client.Flush(transport); err != nil {
		t.Fatalf("flush: %v", err)
	}
	return transport.apiKeys
}

func TestClientWithoutKeySendsWithServerAPIKeyVariable(t *testing.T) {
	t.Setenv("LOGBREW_SERVER_API_KEY", "env-server-key")

	if got := sentAPIKeys(t, Config{}); len(got) != 1 || got[0] != "env-server-key" {
		t.Fatalf("sent keys = %v, want [env-server-key]", got)
	}
}

func TestExplicitKeyWinsOverServerAPIKeyVariable(t *testing.T) {
	t.Setenv("LOGBREW_SERVER_API_KEY", "env-server-key")

	if got := sentAPIKeys(t, Config{APIKey: "explicit-key"}); len(got) != 1 || got[0] != "explicit-key" {
		t.Fatalf("sent keys = %v, want [explicit-key]", got)
	}
}

func TestMissingKeyNamesServerAPIKeyVariable(t *testing.T) {
	t.Setenv("LOGBREW_SERVER_API_KEY", " ")

	_, err := NewClient(Config{})
	var sdkErr *SdkError
	if !errors.As(err, &sdkErr) || sdkErr.Code != "configuration_error" || !strings.Contains(sdkErr.Message, "LOGBREW_SERVER_API_KEY") {
		t.Fatalf("err = %v, want configuration_error naming LOGBREW_SERVER_API_KEY", err)
	}
}
