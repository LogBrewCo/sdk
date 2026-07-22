package logbrew

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	httpClientTestTraceID  = "4bf92f3577b34da6a3ce929d0e0e4736"
	httpClientTestParentID = "00f067aa0ba902b7"
)

type httpClientSpanEvent struct {
	ID         string         `json:"id"`
	Attributes map[string]any `json:"attributes"`
}

func TestHTTPClientCorrelationRequiresValidParentForLiteralPassThrough(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		context context.Context
	}{
		{name: "missing", context: context.Background()},
		{
			name: "malformed",
			context: ContextWithLogBrewTrace(context.Background(), TraceContext{
				TraceID:    "not-a-trace",
				SpanID:     "not-a-span",
				TraceFlags: "zz",
			}),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := sampleClient(t)
			var baseCalls atomic.Int32
			var spanIDCalls atomic.Int32
			var clockCalls atomic.Int32
			var reports atomic.Int32
			var received *http.Request
			response := &http.Response{StatusCode: http.StatusNoContent, Body: http.NoBody}
			transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
				Client: client,
				Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
					baseCalls.Add(1)
					received = request
					return response, nil
				}),
				SpanIDFactory: func() string {
					spanIDCalls.Add(1)
					return "b7ad6b7169203331"
				},
				Now: func() time.Time {
					clockCalls.Add(1)
					return time.Now()
				},
				OnError: func(error) {
					reports.Add(1)
				},
			})
			if err != nil {
				t.Fatal(err)
			}
			request, err := http.NewRequestWithContext(test.context, http.MethodGet, "https://api.example.test/opaque/path?marker=value", nil)
			if err != nil {
				t.Fatal(err)
			}
			request.Header.Set("traceparent", "caller-owned")

			got, gotErr := transport.RoundTrip(request)
			if gotErr != nil || got != response {
				t.Fatalf("literal pass-through changed result: response=%#v error=%v", got, gotErr)
			}
			if received != request || baseCalls.Load() != 1 {
				t.Fatalf("literal pass-through changed request or call count: request=%p received=%p calls=%d", request, received, baseCalls.Load())
			}
			if request.Header.Get("traceparent") != "caller-owned" {
				t.Fatalf("caller header changed: %#v", request.Header)
			}
			if spanIDCalls.Load() != 0 || clockCalls.Load() != 0 || reports.Load() != 0 || client.PendingEvents() != 0 {
				t.Fatalf("no-parent path performed tracing work: span=%d clock=%d reports=%d events=%d", spanIDCalls.Load(), clockCalls.Load(), reports.Load(), client.PendingEvents())
			}
		})
	}
}

func TestHTTPClientCorrelationCreatesExactChildAndPreservesCaller(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	parent := mustHTTPClientParent(t, httpClientTestParentID)
	request, err := http.NewRequestWithContext(
		ContextWithLogBrewTrace(context.Background(), parent),
		http.MethodPost,
		"https://API.Example.Test.:8443/orders/opaque?marker=value#fragment",
		strings.NewReader("caller body"),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("traceparent", "caller-owned")
	request.Header.Set("authorization", "Bearer caller-auth")
	originalContext := request.Context()
	originalBody := request.Body
	response := &http.Response{StatusCode: http.StatusCreated, Body: io.NopCloser(strings.NewReader("response body"))}
	var sent *http.Request
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(cloned *http.Request) (*http.Response, error) {
			sent = cloned
			response.Request = cloned
			return response, nil
		}),
		EventIDPrefix: "checkout_http",
		RouteTemplate: "/orders/opaque/:entity_id",
		Metadata: map[string]any{
			"entityId":      "entity-opaque",
			"requestHeader": "Bearer metadata-auth",
		},
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
		Now: sequenceClock(
			time.Date(2026, 7, 20, 8, 0, 0, 0, time.UTC),
			time.Date(2026, 7, 20, 8, 0, 0, int(25*time.Millisecond), time.UTC),
		),
	})
	if err != nil {
		t.Fatal(err)
	}
	stored := transport.(*httpClientTraceTransport).config
	if stored.RouteTemplate != "" || stored.Metadata != nil || stored.CapturePhaseTimings {
		t.Fatalf("legacy free-form inputs were retained: %#v", stored)
	}

	got, gotErr := transport.RoundTrip(request)
	if gotErr != nil || got != response {
		t.Fatalf("RoundTrip changed app result: response=%#v error=%v", got, gotErr)
	}
	if sent == nil || sent == request {
		t.Fatal("expected an isolated request clone")
	}
	if sent.Body != originalBody || request.Body != originalBody || request.Context() != originalContext {
		t.Fatal("request body or caller context changed")
	}
	if request.Header.Get("traceparent") != "caller-owned" || request.Header.Get("authorization") != "Bearer caller-auth" {
		t.Fatalf("caller headers changed: %#v", request.Header)
	}
	if got := sent.Header.Get("traceparent"); got != "00-"+httpClientTestTraceID+"-b7ad6b7169203331-01" {
		t.Fatalf("unexpected propagated traceparent: %q", got)
	}
	if sent.Header.Get("authorization") != "Bearer caller-auth" {
		t.Fatal("request clone did not preserve app header")
	}
	child, ok := LogBrewTraceFromContext(sent.Context())
	if !ok || child.TraceID != httpClientTestTraceID || child.ParentSpanID != httpClientTestParentID || child.SpanID != "b7ad6b7169203331" || !child.Sampled {
		t.Fatalf("unexpected child context: %#v", child)
	}

	events := previewHTTPClientSpans(t, client)
	if len(events) != 1 {
		t.Fatalf("expected one span, got %d", len(events))
	}
	attributes := events[0].Attributes
	metadata := attributes["metadata"].(map[string]any)
	if events[0].ID != "checkout_http_span_1" || attributes["name"] != "HTTP POST" || attributes["traceId"] != httpClientTestTraceID || attributes["spanId"] != "b7ad6b7169203331" || attributes["parentSpanId"] != httpClientTestParentID || attributes["durationMs"] != float64(25) {
		t.Fatalf("unexpected span: %#v", events[0])
	}
	if metadata["source"] != "net/http.client" || metadata["method"] != "POST" || metadata["host"] != "api.example.test" || metadata["statusCode"] != float64(http.StatusCreated) || metadata["sampled"] != true {
		t.Fatalf("unexpected metadata: %#v", metadata)
	}
	payload := previewHTTPClientPayload(t, client)
	for _, forbidden := range []string{"8443", "/orders/opaque", "marker=value", "fragment", "authorization", "caller-auth", "caller body", "response body", "caller-owned", "routeTemplate", "entity-opaque", "metadata-auth", "entityId", "requestHeader"} {
		if strings.Contains(payload, forbidden) {
			t.Fatalf("span payload leaked %q: %s", forbidden, payload)
		}
	}
}

func TestHTTPClientCorrelationSetupFailureIsAdvisory(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	request := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/private", httpClientTestParentID)
	response := &http.Response{StatusCode: http.StatusAccepted, Body: http.NoBody}
	var baseCalls atomic.Int32
	var received *http.Request
	var reports atomic.Int32
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(got *http.Request) (*http.Response, error) {
			baseCalls.Add(1)
			received = got
			return response, nil
		}),
		SpanIDFactory: func() string { panic("setup detail") },
		OnError: func(error) {
			reports.Add(1)
			panic("callback detail")
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	got, gotErr := transport.RoundTrip(request)
	if gotErr != nil || got != response || received != request || baseCalls.Load() != 1 {
		t.Fatalf("advisory setup failure changed app send: response=%#v error=%v request=%p received=%p calls=%d", got, gotErr, request, received, baseCalls.Load())
	}
	if reports.Load() != 1 || client.PendingEvents() != 0 {
		t.Fatalf("unexpected advisory result: reports=%d events=%d", reports.Load(), client.PendingEvents())
	}
}

func TestHTTPClientCorrelationRejectsUnsafeLabels(t *testing.T) {
	t.Parallel()

	for _, label := range []string{
		strings.Repeat("a", 65),
		"has space",
		"path/segment",
		"label@example.test",
		"unicode-\u00e9",
	} {
		_, err := NewHTTPClientTransport(HTTPClientTransportConfig{Client: sampleClient(t), EventIDPrefix: label})
		if err == nil {
			t.Fatalf("expected unsafe label %q to fail", label)
		}
		var sdkErr *SdkError
		if !errors.As(err, &sdkErr) || sdkErr.Code != "configuration_error" || strings.Contains(err.Error(), label) {
			t.Fatalf("unexpected label error for %q: %v", label, err)
		}
	}
}

func TestHTTPClientCorrelationOmitsIPLikeAndMalformedHosts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		host string
		want string
	}{
		{host: "API.Example.Test.", want: "api.example.test"},
		{host: "127.0.0.1"},
		{host: "127.1"},
		{host: "2130706433"},
		{host: "2001:db8::1"},
		{host: "bad_label.example"},
		{host: "-bad.example"},
	}

	for index, test := range tests {
		t.Run(fmt.Sprintf("case_%d", index), func(t *testing.T) {
			client := sampleClient(t)
			request := mustHTTPClientRequest(t, http.MethodGet, "https://"+test.host+"/private", httpClientTestParentID)
			transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
				Client: client,
				Base: roundTripFunc(func(got *http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: got}, nil
				}),
				SpanIDFactory: func() string { return fmt.Sprintf("%016x", index+1) },
			})
			if err != nil {
				t.Fatal(err)
			}
			response, err := transport.RoundTrip(request)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			metadata := previewHTTPClientSpans(t, client)[0].Attributes["metadata"].(map[string]any)
			if got, ok := metadata["host"].(string); ok || test.want != "" {
				if got != test.want {
					t.Fatalf("host normalization mismatch: got %q want %q metadata=%#v", got, test.want, metadata)
				}
			}
		})
	}
}

func TestHTTPClientCorrelationPreservesErrorAndCancellationIdentity(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		err       error
		errorType string
		cancelled bool
	}{
		{name: "error", err: errors.New("transport detail"), errorType: "transport"},
		{name: "cancelled", err: context.Canceled, errorType: "cancelled", cancelled: true},
		{name: "deadline", err: context.DeadlineExceeded, errorType: "deadline"},
		{name: "network", err: fixedHTTPClientNetworkError{}, errorType: "network"},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client := sampleClient(t)
			transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
				Client:        client,
				Base:          roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, test.err }),
				SpanIDFactory: func() string { return fmt.Sprintf("%016x", index+1) },
			})
			if err != nil {
				t.Fatal(err)
			}
			response, gotErr := transport.RoundTrip(mustHTTPClientRequest(t, http.MethodDelete, "https://api.example.test/private", httpClientTestParentID))
			if response != nil || gotErr != test.err {
				t.Fatalf("transport identity changed: response=%#v error=%v", response, gotErr)
			}
			metadata := previewHTTPClientSpans(t, client)[0].Attributes["metadata"].(map[string]any)
			if metadata["errorType"] != test.errorType {
				t.Fatalf("missing type-only error metadata: %#v", metadata)
			}
			if got, ok := metadata["cancelled"].(bool); ok != test.cancelled || (ok && !got) {
				t.Fatalf("unexpected cancellation metadata: %#v", metadata)
			}
			if strings.Contains(previewHTTPClientPayload(t, client), "transport detail") {
				t.Fatal("error message leaked")
			}
		})
	}
}

func TestHTTPClientCorrelationInstrumentsNilCallerHeader(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	request := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/private", httpClientTestParentID)
	request.Header = nil
	var sent *http.Request
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(got *http.Request) (*http.Response, error) {
			sent = got
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: got}, nil
		}),
		SpanIDFactory: func() string { return "b7ad6b7169203331" },
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := transport.RoundTrip(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if request.Header != nil || sent == nil || sent.Header.Get("traceparent") != "00-"+httpClientTestTraceID+"-b7ad6b7169203331-01" || client.PendingEvents() != 1 {
		t.Fatalf("nil caller header was not privately instrumented: caller=%#v sent=%#v events=%d", request.Header, sent, client.PendingEvents())
	}
}

func TestHTTPClientCorrelationIsolatesConcurrentChildren(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	var spanCounter atomic.Uint64
	seen := make(chan TraceContext, 8)
	release := make(chan struct{})
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			trace, ok := LogBrewTraceFromContext(request.Context())
			if !ok {
				t.Error("missing child context")
			}
			seen <- trace
			<-release
			return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: request}, nil
		}),
		SpanIDFactory: func() string { return fmt.Sprintf("%016x", spanCounter.Add(1)) },
	})
	if err != nil {
		t.Fatal(err)
	}

	const requests = 8
	var wait sync.WaitGroup
	wait.Add(requests)
	for index := 0; index < requests; index++ {
		go func(index int) {
			defer wait.Done()
			parentID := fmt.Sprintf("%016x", index+100)
			response, err := transport.RoundTrip(mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/private", parentID))
			if err != nil {
				t.Errorf("RoundTrip failed: %v", err)
				return
			}
			_ = response.Body.Close()
		}(index)
	}

	children := make([]TraceContext, 0, requests)
	for len(children) < requests {
		children = append(children, <-seen)
	}
	close(release)
	wait.Wait()

	spanIDs := map[string]struct{}{}
	parentIDs := map[string]struct{}{}
	for _, child := range children {
		spanIDs[child.SpanID] = struct{}{}
		parentIDs[child.ParentSpanID] = struct{}{}
		if child.TraceID != httpClientTestTraceID {
			t.Fatalf("child escaped trace: %#v", child)
		}
	}
	if len(spanIDs) != requests || len(parentIDs) != requests || len(previewHTTPClientSpans(t, client)) != requests {
		t.Fatalf("concurrent children collided: spans=%d parents=%d events=%d", len(spanIDs), len(parentIDs), client.PendingEvents())
	}
}

func TestHTTPClientCorrelationCreatesOneChildPerActualAttempt(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	var calls atomic.Int32
	var spanCounter atomic.Uint64
	var traceparents []string
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client: client,
		Base: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			traceparents = append(traceparents, request.Header.Get("traceparent"))
			return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: http.NoBody, Request: request}, nil
		}),
		SpanIDFactory: func() string { return fmt.Sprintf("%016x", spanCounter.Add(1)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	request := mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/private", httpClientTestParentID)
	for attempt := 0; attempt < 2; attempt++ {
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
	}
	if calls.Load() != 2 || len(previewHTTPClientSpans(t, client)) != 2 || len(traceparents) != 2 || traceparents[0] == traceparents[1] {
		t.Fatalf("actual attempts did not receive distinct children: calls=%d traceparents=%#v events=%d", calls.Load(), traceparents, client.PendingEvents())
	}
}

func TestHTTPClientCorrelationSuppressesDuplicateWrappingAndSDKDelivery(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	var leafCalls atomic.Int32
	leaf := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		leafCalls.Add(1)
		return &http.Response{StatusCode: http.StatusAccepted, Body: http.NoBody, Request: request}, nil
	})
	inner, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client:        client,
		Base:          leaf,
		EventIDPrefix: "inner",
		SpanIDFactory: func() string { return "0000000000000001" },
	})
	if err != nil {
		t.Fatal(err)
	}
	directDuplicate, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client:        client,
		Base:          inner,
		EventIDPrefix: "ignored",
		SpanIDFactory: func() string { return "0000000000000002" },
	})
	if err != nil {
		t.Fatal(err)
	}
	if directDuplicate != inner {
		t.Fatal("direct duplicate wrapper was not idempotent")
	}
	bridge := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return inner.RoundTrip(request)
	})
	outer, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client:        client,
		Base:          bridge,
		EventIDPrefix: "outer",
		SpanIDFactory: func() string { return "0000000000000003" },
	})
	if err != nil {
		t.Fatal(err)
	}
	response, err := outer.RoundTrip(mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/private", httpClientTestParentID))
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if leafCalls.Load() != 1 || len(previewHTTPClientSpans(t, client)) != 1 {
		t.Fatalf("nested wrappers duplicated work: calls=%d events=%d", leafCalls.Load(), client.PendingEvents())
	}

	beforeSelfDelivery := client.PendingEvents()
	marked := markLogBrewHTTPDelivery(mustHTTPClientRequest(t, http.MethodPost, "https://api.example.test/v1/events", httpClientTestParentID))
	response, err = outer.RoundTrip(marked)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if leafCalls.Load() != 2 || client.PendingEvents() != beforeSelfDelivery {
		t.Fatalf("marked SDK delivery recursed or emitted a span: calls=%d events=%d", leafCalls.Load(), client.PendingEvents())
	}

	var deliveryCalls atomic.Int32
	deliveryBase := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		deliveryCalls.Add(1)
		return &http.Response{StatusCode: http.StatusAccepted, Header: make(http.Header), Body: http.NoBody, Request: request}, nil
	})
	deliveryTracing, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client:        client,
		Base:          deliveryBase,
		EventIDPrefix: "delivery",
		SpanIDFactory: func() string { return "0000000000000004" },
	})
	if err != nil {
		t.Fatal(err)
	}
	parentInjector := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		ctx := ContextWithLogBrewTrace(request.Context(), mustHTTPClientParent(t, httpClientTestParentID))
		return deliveryTracing.RoundTrip(request.WithContext(ctx))
	})
	delivery, err := NewHTTPTransport(HTTPTransportConfig{
		Endpoint: "https://api.example.test/v1/events",
		Client:   &http.Client{Transport: parentInjector},
	})
	if err != nil {
		t.Fatal(err)
	}
	beforeSend := client.PendingEvents()
	result, err := delivery.Send("lbk_test_key", []byte(`{"events":[]}`))
	if err != nil || result.StatusCode != http.StatusAccepted || deliveryCalls.Load() != 1 || client.PendingEvents() != beforeSend {
		t.Fatalf("SDK delivery was traced or recursed: result=%#v error=%v calls=%d events=%d", result, err, deliveryCalls.Load(), client.PendingEvents())
	}
}

func TestHTTPClientCorrelationCreatesOneChildPerRedirectRoundTrip(t *testing.T) {
	t.Parallel()

	client := sampleClient(t)
	var calls atomic.Int32
	var spanCounter atomic.Uint64
	finalResponse := &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}
	base := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		attempt := calls.Add(1)
		if attempt == 1 {
			return &http.Response{
				StatusCode: http.StatusFound,
				Header:     http.Header{"Location": []string{"/redirected/opaque?marker=value"}},
				Body:       http.NoBody,
				Request:    request,
			}, nil
		}
		finalResponse.Request = request
		return finalResponse, nil
	})
	transport, err := NewHTTPClientTransport(HTTPClientTransportConfig{
		Client:        client,
		Base:          base,
		SpanIDFactory: func() string { return fmt.Sprintf("%016x", spanCounter.Add(1)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	httpClient := &http.Client{Transport: transport}
	response, err := httpClient.Do(mustHTTPClientRequest(t, http.MethodGet, "https://api.example.test/start/opaque?marker=value", httpClientTestParentID))
	if err != nil || response != finalResponse {
		t.Fatalf("redirect changed final result: response=%#v error=%v", response, err)
	}
	_ = response.Body.Close()
	events := previewHTTPClientSpans(t, client)
	if calls.Load() != 2 || len(events) != 2 || events[0].Attributes["spanId"] == events[1].Attributes["spanId"] {
		t.Fatalf("redirect attempts were not independently traced: calls=%d events=%#v", calls.Load(), events)
	}
	payload := previewHTTPClientPayload(t, client)
	if strings.Contains(payload, "/start/opaque") || strings.Contains(payload, "/redirected/opaque") || strings.Contains(payload, "marker=value") {
		t.Fatalf("redirect payload leaked request target: %s", payload)
	}
}

func mustHTTPClientParent(t *testing.T, parentID string) TraceContext {
	t.Helper()
	trace, err := NewTraceContext(TraceContextInput{
		Traceparent: "00-" + httpClientTestTraceID + "-" + httpClientTestParentID + "-01",
		SpanID:      parentID,
	})
	if err != nil {
		t.Fatal(err)
	}
	return trace
}

func mustHTTPClientRequest(t *testing.T, method, target, parentID string) *http.Request {
	t.Helper()
	request, err := http.NewRequestWithContext(
		ContextWithLogBrewTrace(context.Background(), mustHTTPClientParent(t, parentID)),
		method,
		target,
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func sequenceClock(values ...time.Time) func() time.Time {
	var index atomic.Int32
	return func() time.Time {
		current := int(index.Add(1) - 1)
		if current >= len(values) {
			return values[len(values)-1]
		}
		return values[current]
	}
}

func previewHTTPClientSpans(t *testing.T, client *Client) []httpClientSpanEvent {
	t.Helper()
	var payload struct {
		Events []httpClientSpanEvent `json:"events"`
	}
	if err := json.Unmarshal([]byte(previewHTTPClientPayload(t, client)), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Events
}

func previewHTTPClientPayload(t *testing.T, client *Client) string {
	t.Helper()
	payload, err := client.PreviewJSON()
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

type fixedHTTPClientNetworkError struct{}

func (fixedHTTPClientNetworkError) Error() string   { return "network detail" }
func (fixedHTTPClientNetworkError) Timeout() bool   { return false }
func (fixedHTTPClientNetworkError) Temporary() bool { return true }
