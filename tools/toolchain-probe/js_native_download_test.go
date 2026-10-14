package main

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestJSNativeDownloadRedirects(t *testing.T) {
	t.Parallel()
	for _, address := range []string{
		"http://release-assets.githubusercontent.com/fixture",
		"https://example.test/fixture",
		"https://release-assets.githubusercontent.com:443/fixture",
		"https://fixture@release-assets.githubusercontent.com/fixture",
	} {
		parsed, err := url.Parse(address)
		if err != nil || jsNativeRedirectAllowed(parsed) {
			t.Fatal("unapproved native download redirect accepted")
		}
	}
	parsed, err := url.Parse("https://release-assets.githubusercontent.com/fixture?download=1")
	if err != nil || !jsNativeRedirectAllowed(parsed) {
		t.Fatal("approved native asset redirect rejected")
	}
}

func TestJSNativeDownloadRejectsResponse(t *testing.T) {
	t.Parallel()
	specification, valid := jsNativeArchiveForPlatform("darwin/arm64")
	if !valid {
		t.Fatal("download fixture platform unavailable")
	}
	for _, status := range []int{http.StatusOK, http.StatusNotFound} {
		body := &pythonRegistryFixtureBody{
			reader:    strings.NewReader("unverified download fixture"),
			readError: false, closeError: false, closed: false,
		}
		client := new(http.Client)
		client.Transport = pythonRegistryFixtureTransport(func(request *http.Request) (*http.Response, error) {
			if request.URL.String() != jsNativeReleaseURL+specification.name ||
				request.Header.Get("Authorization") != "" {
				t.Fatal("native download request changed")
			}
			response := new(http.Response)
			response.StatusCode, response.Body = status, body
			return response, nil
		})
		data, accepted := jsNativeDownload(t.Context(), client, specification)
		if accepted || data != nil || !body.closed {
			t.Fatal("unverified response accepted or body left open")
		}
	}
	if data, valid := jsNativeDownload(t.Context(), nil, specification); valid || data != nil {
		t.Fatal("missing download client accepted")
	}
}

func TestJSNativeDownloadClient(t *testing.T) {
	t.Parallel()
	client := jsNativeDownloadClient()
	if client == nil || client.Timeout != jsSyntaxTimeout || client.CheckRedirect == nil {
		t.Fatal("native download client bounds unavailable")
	}
	transport, valid := client.Transport.(*http.Transport)
	if !valid || transport.Proxy != nil || transport.MaxResponseHeaderBytes != pythonRegistryHeaders {
		t.Fatal("native download transport bounds changed")
	}
}
