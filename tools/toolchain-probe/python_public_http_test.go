package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type pythonRegistryFixtureTransport func(*http.Request) (*http.Response, error)

const pythonRegistryTransportFailure = "transport"

func (transport pythonRegistryFixtureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

type pythonRegistryFixtureBody struct {
	reader                io.Reader
	readError, closeError bool
	closed                bool
}

func (body *pythonRegistryFixtureBody) Read(output []byte) (int, error) {
	if body.readError {
		return 0, io.ErrUnexpectedEOF
	}
	count, err := body.reader.Read(output)
	if errors.Is(err, io.EOF) {
		return count, io.EOF
	}
	if err != nil {
		return count, fmt.Errorf("read registry fixture: %w", err)
	}
	return count, nil
}

func (body *pythonRegistryFixtureBody) Close() error {
	body.closed = true
	if body.closeError {
		return io.ErrUnexpectedEOF
	}
	return nil
}

func TestPythonPublicReadsRejectHTTPFailuresAndCloseBodies(t *testing.T) {
	t.Parallel()
	for _, mode := range []string{
		"accepted-response", "http-status", "read", "close", "body-limit",
		pythonRegistryTransportFailure, "missing-url",
	} {
		t.Run(mode, func(t *testing.T) {
			t.Parallel()
			data := pythonPublicFixture(t)
			if mode == "body-limit" {
				data = bytes.Repeat([]byte("x"), pythonManifestLimit+1)
			}
			body := &pythonRegistryFixtureBody{
				reader: bytes.NewReader(data), readError: mode == "read", closeError: mode == "close", closed: false,
			}
			client := new(http.Client)
			client.Transport = pythonPublicFixtureTransport(t, mode, body)
			records, valid := fetchPythonPublicMetadata(t.Context(), client,
				pythonReleaseCatalog()[0], pythonPublicFixtureVersion)
			if valid != (mode == "accepted-response") || mode != pythonRegistryTransportFailure && !body.closed ||
				valid && len(records) != pythonReleaseFileCount {
				t.Fatal("registry response failed closed-state or body cleanup checks")
			}
		})
	}
}

func TestPythonPublicClientBoundsAndCancellation(t *testing.T) {
	t.Parallel()
	client := newPythonRegistryClient()
	if client == nil || client.Timeout <= 0 || client.Timeout > pythonRegistryTimeout || client.Jar != nil ||
		client.CheckRedirect == nil || !errors.Is(client.CheckRedirect(nil, nil), http.ErrUseLastResponse) {
		t.Fatal("public client has unbounded or ambient state")
	}
	transport, valid := client.Transport.(*http.Transport)
	if !valid || transport.Proxy != nil || transport.MaxConnsPerHost != pythonRegistryConnections ||
		transport.ResponseHeaderTimeout <= 0 || transport.MaxResponseHeaderBytes != pythonRegistryHeaders {
		t.Fatal("public transport limits missing")
	}
	client.CloseIdleConnections()
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Millisecond)
	defer cancel()
	if _, accepted := fetchPythonPublicMetadata(ctx, client,
		pythonReleaseCatalog()[0], pythonPublicFixtureVersion); accepted {
		t.Fatal("cancelled registry lookup passed")
	}
}

func TestPythonPublicArtifactDigestIsIndependentOfMetadata(t *testing.T) {
	t.Parallel()
	data := []byte("abc")
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		response := new(http.Response)
		response.StatusCode, response.Request = http.StatusOK, request
		response.Body = io.NopCloser(bytes.NewReader(data))
		return response, nil
	})
	name := "logbrew_sdk-0.1.4-py3-none-any.whl"
	artifact := pythonPublicArtifact{
		url: "https://files.pythonhosted.org/packages/example/" + name, sha256: strings.Repeat("a", 64),
	}
	if _, valid := downloadPythonPublicArtifact(t.Context(), client, artifact, name); valid {
		t.Fatal("download accepted bytes that differ from the registry hash")
	}
	artifact.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	readback, valid := downloadPythonPublicArtifact(t.Context(), client, artifact, name)
	if !valid || !bytes.Equal(readback, data) {
		t.Fatal("download rejected bytes with the exact independently known digest")
	}
	data = []byte("changed-public-bytes")
	if _, valid = downloadPythonPublicArtifact(t.Context(), client, artifact, name); valid {
		t.Fatal("changed download retained its previous identity")
	}
}

func TestPythonPublicRedirectDoesNotContactAnotherOrigin(t *testing.T) {
	t.Parallel()
	client := newPythonRegistryClient()
	if client == nil {
		t.Fatal("registry client unavailable")
	}
	defer client.CloseIdleConnections()
	requests := 0
	body := &pythonRegistryFixtureBody{
		reader: strings.NewReader("redirect"), readError: false, closeError: false, closed: false,
	}
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		requests++
		response := new(http.Response)
		response.Request, response.StatusCode, response.Body = request, http.StatusFound, body
		response.Header = http.Header{"Location": []string{"https://example.invalid/redirected"}}
		return response, nil
	})
	if _, valid := fetchPythonPublicMetadata(t.Context(), client,
		pythonReleaseCatalog()[0], pythonPublicFixtureVersion); valid || requests != 1 || !body.closed {
		t.Fatal("registry redirect followed another origin or leaked its body")
	}
}

func pythonPublicFixtureTransport(
	t *testing.T, mode string, body *pythonRegistryFixtureBody,
) pythonRegistryFixtureTransport {
	t.Helper()
	return pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.String() !=
			"https://pypi.org/pypi/logbrew-sdk/0.1.4/json" || request.Header.Get("Authorization") != "" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("User-Agent") == "" {
			t.Fatal("registry request changed its exact public scope")
		}
		if mode == pythonRegistryTransportFailure {
			return nil, io.ErrUnexpectedEOF
		}
		response := new(http.Response)
		response.StatusCode, response.Request, response.Body = http.StatusOK, request, body
		if mode == "http-status" {
			response.StatusCode = http.StatusNotFound
		}
		if mode == "missing-url" {
			response.Request = request.Clone(request.Context())
			response.Request.URL = nil
		}
		return response, nil
	})
}
