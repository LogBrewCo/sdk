package main

import (
	"net/http"
	"time"
)

func newRegistryClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		return nil
	}
	client := newPythonRegistryClient()
	if client == nil {
		return nil
	}
	transport, valid := client.Transport.(*http.Transport)
	if !valid {
		return nil
	}
	client.Timeout = timeout
	transport.ResponseHeaderTimeout = timeout
	transport.TLSHandshakeTimeout = timeout
	return client
}
