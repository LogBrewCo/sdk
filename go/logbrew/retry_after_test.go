package logbrew

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestParseRetryAfterRequiresOneRFCValueAndClamps(t *testing.T) {
	now := time.Date(2026, 7, 16, 10, 0, 0, 0, time.UTC)
	maximum := 5 * time.Second
	tests := []struct {
		name        string
		values      []string
		wantPresent bool
		wantValid   bool
		wantDelay   time.Duration
		wantClamped bool
	}{
		{name: "absent"},
		{name: "delta", values: []string{"3"}, wantPresent: true, wantValid: true, wantDelay: 3 * time.Second},
		{name: "zero_delta", values: []string{"0"}, wantPresent: true, wantValid: true},
		{name: "delta_ows", values: []string{"\t4 "}, wantPresent: true, wantValid: true, wantDelay: 4 * time.Second},
		{name: "delta_clamped", values: []string{"999999999999999999999999999999"}, wantPresent: true, wantValid: true, wantDelay: maximum, wantClamped: true},
		{name: "imf_fixdate", values: []string{now.Add(2 * time.Second).Format(http.TimeFormat)}, wantPresent: true, wantValid: true, wantDelay: 2 * time.Second},
		{name: "imf_fixdate_clamped", values: []string{now.Add(time.Minute).Format(http.TimeFormat)}, wantPresent: true, wantValid: true, wantDelay: maximum, wantClamped: true},
		{name: "duplicate", values: []string{"1", "2"}, wantPresent: true},
		{name: "comma_joined_delta", values: []string{"1, 2"}, wantPresent: true},
		{name: "malformed", values: []string{"later"}, wantPresent: true},
		{name: "negative", values: []string{"-1"}, wantPresent: true},
		{name: "fractional", values: []string{"1.5"}, wantPresent: true},
		{name: "past_date", values: []string{now.Add(-time.Second).Format(http.TimeFormat)}, wantPresent: true},
		{name: "legacy_rfc850_date", values: []string{"Sunday, 06-Nov-94 08:49:37 GMT"}, wantPresent: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseRetryAfter(test.values, now, maximum)
			if got.present != test.wantPresent || got.valid != test.wantValid || got.delay != test.wantDelay || got.clamped != test.wantClamped {
				t.Fatalf("unexpected directive: %#v", got)
			}
		})
	}
}

func TestHTTPTransportPreservesRetryAfterMultiplicityForStrictParsing(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Add("Retry-After", "1")
		response.Header().Add("Retry-After", "2")
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer server.Close()
	transport, err := NewHTTPTransport(HTTPTransportConfig{Endpoint: server.URL, Client: server.Client()})
	if err != nil {
		t.Fatal(err)
	}
	response, directive, err := transport.sendWithRetryAfter("LOGBREW_API_KEY", []byte(`{"events":[]}`), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusServiceUnavailable || !directive.present || directive.valid {
		t.Fatalf("duplicate Retry-After was not preserved as invalid: response=%#v directive=%#v", response, directive)
	}
}

type retryAfterTestResponse struct {
	status    int
	directive retryAfterDirective
}

type retryAfterTestTransport struct {
	mu        sync.Mutex
	responses []retryAfterTestResponse
	bodies    [][]byte
	sent      chan struct{}
	block     <-chan struct{}
}

func newRetryAfterTestTransport(responses ...retryAfterTestResponse) *retryAfterTestTransport {
	return &retryAfterTestTransport{
		responses: append([]retryAfterTestResponse(nil), responses...),
		sent:      make(chan struct{}, 16),
	}
}

func (t *retryAfterTestTransport) Send(apiKey string, body []byte) (*TransportResponse, error) {
	response, _, err := t.sendWithRetryAfter(apiKey, body, defaultRetryMaxDelay)
	return response, err
}

func (t *retryAfterTestTransport) sendWithRetryAfter(_ string, body []byte, _ time.Duration) (*TransportResponse, retryAfterDirective, error) {
	t.mu.Lock()
	response := retryAfterTestResponse{status: http.StatusAccepted}
	if len(t.responses) > 0 {
		response = t.responses[0]
		t.responses = t.responses[1:]
	}
	t.bodies = append(t.bodies, append([]byte(nil), body...))
	t.mu.Unlock()
	t.sent <- struct{}{}
	if t.block != nil {
		<-t.block
	}
	return &TransportResponse{StatusCode: response.status, Attempts: 1}, response.directive, nil
}

func (t *retryAfterTestTransport) waitForSend(testingT *testing.T) {
	testingT.Helper()
	select {
	case <-t.sent:
	case <-time.After(time.Second):
		testingT.Fatal("timed out waiting for transport send")
	}
}

func (t *retryAfterTestTransport) bodiesSnapshot() [][]byte {
	t.mu.Lock()
	defer t.mu.Unlock()
	bodies := make([][]byte, len(t.bodies))
	for index := range t.bodies {
		bodies[index] = append([]byte(nil), t.bodies[index]...)
	}
	return bodies
}

func TestAutomaticDeliveryHonorsServerDelayAndKeepsFrozenPrefix(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true, valid: true, delay: 30 * time.Millisecond}},
		retryAfterTestResponse{status: http.StatusAccepted},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 5 * time.Millisecond,
		RetryMaxDelay:  50 * time.Millisecond,
	})
	client.automatic.jitter = func(delay time.Duration) time.Duration { return delay }
	queueLifecycleLog(t, client, "evt_server_retry_prefix")
	transport.waitForSend(t)

	select {
	case <-transport.sent:
		t.Fatal("server-directed retry bypassed the requested delay")
	case <-time.After(10 * time.Millisecond):
	}
	queueLifecycleLog(t, client, "evt_server_retry_later")
	transport.waitForSend(t)
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)

	bodies := transport.bodiesSnapshot()
	if len(bodies) != 3 || !bytes.Equal(bodies[0], bodies[1]) {
		t.Fatalf("failed prefix changed across server-directed retry: %d", len(bodies))
	}
	if bytes.Contains(bodies[1], []byte("evt_server_retry_later")) || !bytes.Contains(bodies[2], []byte("evt_server_retry_later")) {
		t.Fatal("later capture was not retained behind the frozen failed prefix")
	}
	health := client.DeliveryHealth()
	if health.BackoffSource != DeliveryBackoffSourceServer || health.BackoffOutcome != DeliveryBackoffOutcomeHonored || health.BackoffDelayMillis != 30 || health.ServerBackoffs != 1 || health.ClientBackoffs != 0 {
		t.Fatalf("unexpected server backoff health: %#v", health)
	}
}

func TestMalformedRetryAfterUsesCappedClientFallback(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 20 * time.Millisecond,
		RetryMaxDelay:  20 * time.Millisecond,
	})
	client.automatic.jitter = func(delay time.Duration) time.Duration { return delay / 2 }
	queueLifecycleLog(t, client, "evt_invalid_retry_after")
	transport.waitForSend(t)
	select {
	case <-transport.sent:
		t.Fatal("malformed Retry-After triggered an immediate retry")
	case <-time.After(5 * time.Millisecond):
	}
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)

	health := client.DeliveryHealth()
	if health.BackoffSource != DeliveryBackoffSourceClient || health.BackoffOutcome != DeliveryBackoffOutcomeFallback || health.BackoffDelayMillis != 10 || health.InvalidServerBackoffs != 1 || health.ClientBackoffs != 1 {
		t.Fatalf("unexpected fallback health: %#v", health)
	}
}

func TestAutomaticDeliveryReportsClampedServerDelay(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true, valid: true, delay: 20 * time.Millisecond, clamped: true}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 5 * time.Millisecond,
		RetryMaxDelay:  20 * time.Millisecond,
	})
	client.automatic.jitter = func(delay time.Duration) time.Duration { return delay }
	queueLifecycleLog(t, client, "evt_clamped_retry_after")
	transport.waitForSend(t)
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)

	health := client.DeliveryHealth()
	if health.BackoffSource != DeliveryBackoffSourceServer || health.BackoffOutcome != DeliveryBackoffOutcomeClamped || health.BackoffDelayMillis != 20 || health.ServerBackoffs != 1 {
		t.Fatalf("unexpected clamped backoff health: %#v", health)
	}
}

func TestServerDelayCannotBypassClientBackoffFloor(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true, valid: true, delay: time.Millisecond}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 20 * time.Millisecond,
		RetryMaxDelay:  20 * time.Millisecond,
	})
	client.automatic.jitter = func(delay time.Duration) time.Duration { return delay }
	queueLifecycleLog(t, client, "evt_server_below_floor")
	transport.waitForSend(t)
	select {
	case <-transport.sent:
		t.Fatal("server delay bypassed the client backoff floor")
	case <-time.After(5 * time.Millisecond):
	}
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)
	health := client.DeliveryHealth()
	if health.BackoffSource != DeliveryBackoffSourceClient || health.BackoffOutcome != DeliveryBackoffOutcomeFallback || health.BackoffDelayMillis != 20 || health.ClientBackoffs != 1 {
		t.Fatalf("unexpected client-floor health: %#v", health)
	}
}

func TestRetryAfterDoesNotOverrideTerminalQuotaPause(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusTooManyRequests, directive: retryAfterDirective{present: true, valid: true, delay: time.Millisecond}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport: transport, FlushInterval: time.Hour, FlushThreshold: 1,
	})
	queueLifecycleLog(t, client, "evt_quota_retry_after")
	transport.waitForSend(t)
	waitForState(t, client, DeliveryStatePaused)
	select {
	case <-transport.sent:
		t.Fatal("Retry-After bypassed the terminal quota pause")
	case <-time.After(20 * time.Millisecond):
	}
	health := client.DeliveryHealth()
	if health.LastOutcome != DeliveryOutcomeQuotaPause || health.RetrySchedules != 0 || health.ServerBackoffs != 0 {
		t.Fatalf("unexpected quota health: %#v", health)
	}
}

func TestResumeInvalidatesStaleServerResponseAndTimer(t *testing.T) {
	release := make(chan struct{})
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true, valid: true, delay: time.Hour}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	transport.block = release
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 10 * time.Millisecond,
		RetryMaxDelay:  time.Hour,
	})
	queueLifecycleLog(t, client, "evt_stale_retry_after")
	transport.waitForSend(t)
	if err := client.ResumeDelivery(); err != nil {
		t.Fatal(err)
	}
	close(release)
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)

	health := client.DeliveryHealth()
	if health.State != DeliveryStateRunning || health.ServerBackoffs != 0 || health.BackoffSource != DeliveryBackoffSourceNone {
		t.Fatalf("stale response overwrote recovery state: %#v", health)
	}
}

func TestResumeCancelsAlreadyScheduledServerDelay(t *testing.T) {
	transport := newRetryAfterTestTransport(
		retryAfterTestResponse{status: http.StatusServiceUnavailable, directive: retryAfterDirective{present: true, valid: true, delay: time.Hour}},
		retryAfterTestResponse{status: http.StatusAccepted},
	)
	client := newLifecycleClient(t, &AutomaticDeliveryConfig{
		Transport:      transport,
		FlushInterval:  time.Hour,
		FlushThreshold: 1,
		RetryBaseDelay: 10 * time.Millisecond,
		RetryMaxDelay:  time.Hour,
	})
	queueLifecycleLog(t, client, "evt_cancel_retry_timer")
	transport.waitForSend(t)
	waitForBackoffSource(t, client, DeliveryBackoffSourceServer)
	if err := client.ResumeDelivery(); err != nil {
		t.Fatal(err)
	}
	transport.waitForSend(t)
	waitForPendingEvents(t, client, 0)
	select {
	case <-transport.sent:
		t.Fatal("stale server timer sent after explicit recovery succeeded")
	case <-time.After(20 * time.Millisecond):
	}
}

func waitForBackoffSource(t *testing.T, client *Client, expected string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if client.DeliveryHealth().BackoffSource == expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for backoff source %q: %#v", expected, client.DeliveryHealth())
}
