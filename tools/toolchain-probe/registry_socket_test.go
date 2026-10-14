package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestRegistryTLSRequest(t *testing.T) {
	t.Parallel()
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/stall" {
			<-request.Context().Done()
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if _, err := writer.Write([]byte(`{"versions":{"wanted":{}}}`)); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client := newRegistryClient(time.Second)
	if client == nil {
		t.Fatal("registry client unavailable")
	}
	defer client.CloseIdleConnections()
	transport, valid := client.Transport.(*http.Transport)
	if !valid {
		t.Fatal("registry transport unavailable")
	}
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	transport.TLSClientConfig = new(tls.Config)
	transport.TLSClientConfig.RootCAs = pool
	plan, valid := newRegistryRequest("npm", jsMetadataCore, "")
	if !valid {
		t.Fatal("registry plan unavailable")
	}
	plan.address = server.URL
	result := fetchRegistryResponse(context.Background(), client, plan)
	if !result.readable || !result.versions["wanted"] {
		t.Fatal("TLS registry response did not reach extractor")
	}
	plan.address += "/stall"
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	result = fetchRegistryResponse(ctx, client, plan)
	if result.readable || result.status != 0 {
		t.Fatal("stalled registry response accepted")
	}
}
