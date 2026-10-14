package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"
)

func TestRegistryClientTimeout(t *testing.T) {
	t.Parallel()
	for _, timeout := range []time.Duration{0, -time.Second} {
		if newRegistryClient(timeout) != nil {
			t.Fatal("invalid registry timeout accepted")
		}
	}
	timeout := time.Second
	client := newRegistryClient(timeout)
	if client == nil || client.Timeout != timeout {
		t.Fatal("registry request timeout missing")
	}
	defer client.CloseIdleConnections()
	transport, valid := client.Transport.(*http.Transport)
	if !valid || transport == http.DefaultTransport || transport.ResponseHeaderTimeout != timeout ||
		transport.TLSHandshakeTimeout != timeout || transport.MaxResponseHeaderBytes != pythonRegistryHeaders {
		t.Fatal("registry transport bounds or isolation missing")
	}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "https://example.com", http.NoBody)
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(client.CheckRedirect(request, nil), http.ErrUseLastResponse) {
		t.Fatal("registry redirect unexpectedly followed")
	}
}
