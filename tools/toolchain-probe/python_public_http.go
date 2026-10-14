package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
	"slices"
	"time"
)

const (
	pythonRegistryTimeout     = 20 * time.Second
	pythonRegistryHeaders     = 16 << 10
	pythonRegistryConnections = 2
)

func newPythonRegistryClient() *http.Client {
	base, valid := http.DefaultTransport.(*http.Transport)
	if !valid {
		return nil
	}
	transport := base.Clone()
	transport.Proxy = nil
	transport.MaxConnsPerHost = pythonRegistryConnections
	transport.MaxResponseHeaderBytes = pythonRegistryHeaders
	transport.ResponseHeaderTimeout = pythonRegistryTimeout
	client := new(http.Client)
	client.Transport, client.Timeout = transport, pythonRegistryTimeout
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return client
}

func fetchPythonPublicMetadata(
	ctx context.Context, client *http.Client, spec pythonReleaseSpec, version string,
) (map[string]pythonPublicArtifact, bool) {
	if !slices.Contains(pythonReleaseCatalog(), spec) || !validPythonPackageVersion(version) {
		return nil, false
	}
	address := "https://pypi.org/pypi/" + url.PathEscape(spec.id) + "/" + url.PathEscape(version) + "/json"
	data, valid := readPythonPublicResponse(ctx, client, address, pythonManifestLimit)
	if !valid {
		return nil, false
	}
	return parsePythonPublicMetadata(data, spec, version)
}

func downloadPythonPublicArtifact(
	ctx context.Context, client *http.Client, artifact pythonPublicArtifact, filename string,
) ([]byte, bool) {
	if !validPythonPublicURL(artifact.url, filename) || !pythonLowerHex(artifact.sha256, pythonArtifactHashSize) {
		return nil, false
	}
	data, valid := readPythonPublicResponse(ctx, client, artifact.url, pythonArtifactLimit)
	digest := sha256.Sum256(data)
	return data, valid && hex.EncodeToString(digest[:]) == artifact.sha256
}

func readPythonPublicResponse(ctx context.Context, client *http.Client, address string, limit int64) ([]byte, bool) {
	if client == nil || limit <= 0 || limit > pythonArtifactLimit {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, pythonRegistryTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, http.NoBody)
	if err != nil {
		return nil, false
	}
	request.Header.Set("User-Agent", "LogBrew public package reconciliation")
	response, requestError := client.Do(request)
	if response == nil || response.Body == nil {
		return nil, false
	}
	data, readError := io.ReadAll(io.LimitReader(response.Body, limit+1))
	closeError := response.Body.Close()
	valid := requestError == nil && readError == nil && closeError == nil && ctx.Err() == nil &&
		response.StatusCode == http.StatusOK && response.ContentLength <= limit && int64(len(data)) <= limit &&
		pythonPublicResponseURLMatches(response, address)
	return data, valid
}

func pythonPublicResponseURLMatches(response *http.Response, address string) bool {
	return response.Request != nil && response.Request.URL != nil && response.Request.URL.String() == address
}
