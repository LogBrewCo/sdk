package logbrew_test

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

type idleCloseTransport struct{ calls atomic.Int32 }

func (base *idleCloseTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, io.ErrClosedPipe
}

func (base *idleCloseTransport) CloseIdleConnections() { base.calls.Add(1) }

type noIdleCloseTransport struct{}

func (noIdleCloseTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, io.ErrClosedPipe
}

func TestHTTPClientCloseIdleConnectionsDelegatesWithoutCapture(t *testing.T) {
	t.Parallel()
	client := newHTTPTestClient(t)
	base := &idleCloseTransport{calls: atomic.Int32{}}
	transport := newHTTPTestTransport(t, client, base, false)
	doer := newHTTPTestDoer(transport)
	doer.CloseIdleConnections()
	doer.CloseIdleConnections()

	if base.calls.Load() != 2 {
		t.Fatal("wrapped transport hides CloseIdleConnections from http.Client")
	}

	if client.PendingEvents() != 0 {
		t.Fatal("closing idle connections captured telemetry")
	}

	noIdle := newHTTPTestTransport(t, client, noIdleCloseTransport{}, false)
	newHTTPTestDoer(noIdle).CloseIdleConnections()
}

func TestHTTPClientCloseIdleConnectionsClosesRealIdleConnection(t *testing.T) {
	t.Parallel()

	closed := make(chan struct{}, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	server.Start()
	t.Cleanup(server.Close)
	client := newHTTPTestClient(t)
	transport := newHTTPTestTransport(t, client, newHTTPTestBase(t), false)
	doer := newHTTPTestDoer(transport)
	response := doHTTPTestRequest(t, doer, newHTTPTestRequest(t.Context(), t, server.URL))

	err := response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}

	doer.CloseIdleConnections()
	waitHTTPTestSignal(t, closed)

	if client.PendingEvents() != 0 {
		t.Fatal("closing idle connections created a span without a parent")
	}
}
