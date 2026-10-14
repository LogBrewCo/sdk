package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"
)

const nugetHTTPClose, nugetHTTPStatus = "close", "status"

const nugetHTTPRead = "read"

const nugetHTTPFixtureURL = "https://api.nuget.org/v3/registration5-gz-semver2/logbrew/0.1.7.json"

func TestNugetHTTPEncodingContract(t *testing.T) {
	t.Parallel()
	plain := []byte(`{"packageContent":"synthetic"}`)
	compressed := pythonFixtureGzip(t, plain)
	for _, test := range []struct {
		encodings          []string
		body               []byte
		metadata, accepted bool
	}{
		{nil, plain, true, true},
		{[]string{nugetEncodingIdentity}, plain, true, true},
		{[]string{nugetEncodingGzip}, compressed, true, true},
		{nil, plain, false, true},
		{[]string{nugetEncodingIdentity}, plain, false, false},
		{[]string{nugetEncodingGzip}, compressed, false, false},
		{[]string{"br"}, compressed, true, false},
		{[]string{nugetEncodingGzip, nugetEncodingIdentity}, compressed, true, false},
		{[]string{"gzip, identity"}, compressed, true, false},
		{[]string{"GZIP"}, compressed, true, false},
		{[]string{""}, plain, true, false},
		{[]string{nugetEncodingGzip}, plain, true, false},
		{[]string{nugetEncodingGzip}, append(bytes.Clone(compressed), 'x'), true, false},
		{[]string{nugetEncodingGzip}, append(bytes.Clone(compressed), compressed...), true, false},
		{[]string{nugetEncodingGzip}, compressed[:len(compressed)-1], true, false},
	} {
		body := &pythonRegistryFixtureBody{
			reader: bytes.NewReader(test.body), readError: false, closeError: false, closed: false,
		}
		client := nugetHTTPFixtureClient(t, body, http.Header{"Content-Encoding": test.encodings})
		kind := nugetResponsePackage
		if test.metadata {
			kind = nugetResponseMetadata
		}
		data, valid := readNugetPublicResponse(t.Context(), client, nugetHTTPFixtureURL, kind)
		if valid != test.accepted || !body.closed || valid && !bytes.Equal(data, plain) || !valid && data != nil {
			t.Fatal("NuGet encoding, bounded failure output or body closure changed")
		}
	}
}

func nugetHTTPFixtureClient(t *testing.T, body io.ReadCloser, headers http.Header) *http.Client {
	t.Helper()
	client := newNugetRegistryClient()
	if client == nil {
		t.Fatal("NuGet HTTP client unavailable")
	}
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodGet || request.URL.String() != nugetHTTPFixtureURL ||
			request.Header.Get("Authorization") != "" || request.Header.Get("Cookie") != "" {
			t.Fatal("NuGet request escaped its public scope")
		}
		response := new(http.Response)
		response.StatusCode, response.Request, response.Body, response.Header = http.StatusOK, request, body, headers
		response.ContentLength = -1
		return response, nil
	})
	return client
}

func TestNugetHTTPClientLimits(t *testing.T) {
	t.Parallel()
	client := newNugetRegistryClient()
	if client == nil || client.Timeout != maximumDeadline || client.Jar != nil ||
		client.CheckRedirect == nil || !errors.Is(client.CheckRedirect(nil, nil), http.ErrUseLastResponse) {
		t.Fatal("NuGet HTTP timeout or ambient state changed")
	}
	transport, valid := client.Transport.(*http.Transport)
	if !valid || !transport.DisableCompression || transport.Proxy != nil ||
		transport.MaxConnsPerHost != pythonRegistryConnections ||
		transport.MaxResponseHeaderBytes != pythonRegistryHeaders || transport.ResponseHeaderTimeout <= 0 {
		t.Fatal("NuGet HTTP compression, proxy or resource bounds missing")
	}
	client.CloseIdleConnections()
	client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	ctx, cancel := context.WithTimeout(t.Context(), time.Millisecond)
	defer cancel()
	if _, valid := readNugetPublicResponse(ctx, client, nugetHTTPFixtureURL, nugetResponseMetadata); valid {
		t.Fatal("cancelled NuGet request accepted")
	}
}

func TestNugetHTTPFailureClosesBody(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{
		nugetHTTPRead, nugetHTTPClose, nugetHTTPStatus, "redirect", "length", "expanded", "transport", "invalid-length",
	} {
		t.Run(failure, func(t *testing.T) {
			t.Parallel()
			body := &pythonRegistryFixtureBody{
				reader: bytes.NewReader([]byte("body")), readError: failure == nugetHTTPRead,
				closeError: failure == nugetHTTPClose, closed: false,
			}
			client := newNugetRegistryClient()
			if client == nil {
				t.Fatal("NuGet client unavailable")
			}
			requests := 0
			client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
				requests++
				return nugetHTTPFailureResponse(request, body, failure)
			})
			data, valid := readNugetPublicResponse(t.Context(), client, nugetHTTPFixtureURL, nugetResponseMetadata)
			if valid || data != nil || requests != 1 || failure != "transport" && !body.closed {
				t.Fatal("HTTP failure leaked output, retried, followed a redirect or left its body open")
			}
		})
	}
}

func nugetHTTPFailureResponse(request *http.Request, body io.ReadCloser, failure string) (*http.Response, error) {
	response := new(http.Response)
	response.StatusCode, response.Request, response.Body = http.StatusOK, request, body
	response.ContentLength = -1
	switch failure {
	case nugetHTTPStatus:
		response.StatusCode = http.StatusServiceUnavailable
	case "redirect":
		response.StatusCode = http.StatusFound
		response.Header = http.Header{"Location": []string{"https://example.invalid/redirected"}}
	case "length":
		response.ContentLength = 5
	case "invalid-length":
		response.ContentLength = -2
	case "expanded":
		response.Uncompressed = true
	case nugetHTTPRead, nugetHTTPClose:
		return response, nil
	default:
		return nil, io.ErrUnexpectedEOF
	}
	return response, nil
}

func TestNugetHTTPByteLimits(t *testing.T) {
	t.Parallel()
	for _, kind := range []nugetResponseKind{nugetResponseMetadata, nugetResponsePackage} {
		limit, _ := nugetHTTPBounds(kind)
		for _, delta := range []int64{0, 1} {
			body := &pythonRegistryFixtureBody{
				reader: bytes.NewReader(make([]byte, limit+delta)), readError: false, closeError: false, closed: false,
			}
			client := nugetHTTPFixtureClient(t, body, nil)
			data, valid := readNugetPublicResponse(t.Context(), client, nugetHTTPFixtureURL, kind)
			if valid != (delta == 0) || !body.closed || valid && int64(len(data)) != limit || !valid && data != nil {
				t.Fatal("identity response exact byte limit changed")
			}
		}
	}
}

func TestNugetGzipByteLimits(t *testing.T) {
	t.Parallel()
	for _, delta := range []int{0, 1} {
		encoded := pythonFixtureGzip(t, make([]byte, pythonManifestLimit+delta))
		body, valid := decodeNugetGzip(encoded)
		if valid != (delta == 0) || valid && len(body) != pythonManifestLimit || !valid && body != nil {
			t.Fatal("expanded gzip byte limit changed")
		}
	}
	encoded := nugetExactCompressedFixture(t)
	if _, valid := decodeNugetGzip(encoded); !valid {
		t.Fatal("exact compressed byte limit rejected")
	}
	if _, valid := decodeNugetGzip(append(bytes.Clone(encoded), 0)); valid {
		t.Fatal("compressed byte limit exceeded")
	}
	encoded[len(encoded)-8] ^= 1
	if _, valid := decodeNugetGzip(encoded); valid {
		t.Fatal("gzip checksum failure accepted")
	}
}

func TestNugetHTTPRejectsInvalidInputsBeforeRequests(t *testing.T) {
	t.Parallel()
	client := new(http.Client)
	client.Transport = pythonRegistryFixtureTransport(func(_ *http.Request) (*http.Response, error) {
		t.Fatal("invalid input started a request")
		return nil, io.ErrUnexpectedEOF
	})
	for _, address := range []string{
		"", "://invalid", "https://example.com/", "http://api.nuget.org/",
		"https://user@api.nuget.org/", "https://api.nuget.org:443/",
	} {
		if _, valid := readNugetPublicResponse(t.Context(), client, address, nugetResponseMetadata); valid {
			t.Fatal("invalid registry URL accepted")
		}
	}
	if _, valid := readNugetPublicResponse(t.Context(), nil, nugetHTTPFixtureURL, nugetResponseMetadata); valid {
		t.Fatal("absent client accepted")
	}
	if _, valid := readNugetPublicResponse(t.Context(), client, nugetHTTPFixtureURL, 0); valid {
		t.Fatal("unknown response kind accepted")
	}
}

func nugetExactCompressedFixture(t *testing.T) []byte {
	t.Helper()
	size := nugetCompressedLimit
	for range 3 {
		var output bytes.Buffer
		writer, err := gzip.NewWriterLevel(&output, gzip.NoCompression)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(make([]byte, size)); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		if output.Len() == nugetCompressedLimit {
			return output.Bytes()
		}
		size += nugetCompressedLimit - output.Len()
	}
	t.Fatal("cannot construct exact compressed-size fixture")
	return nil
}
