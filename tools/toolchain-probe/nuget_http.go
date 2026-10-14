package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"time"
)

type nugetResponseKind uint8

const (
	nugetResponseMetadata nugetResponseKind = iota + 1
	nugetResponsePackage
	nugetCompressedLimit  = 1 << 20
	nugetMetadataTimeout  = 30 * time.Second
	nugetEncodingGzip     = "gzip"
	nugetEncodingIdentity = "identity"
)

func newNugetRegistryClient() *http.Client {
	client := newPythonRegistryClient()
	if client == nil {
		return nil
	}
	transport, valid := client.Transport.(*http.Transport)
	if !valid {
		return nil
	}
	// Automatic decompression would hide the compressed-byte and encoding checks.
	transport.DisableCompression = true
	client.Timeout = maximumDeadline
	return client
}

func readNugetPublicResponse(
	ctx context.Context, client *http.Client, address string, kind nugetResponseKind,
) ([]byte, bool) {
	limit, timeout := nugetHTTPBounds(kind)
	if client == nil || limit == 0 {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, http.NoBody)
	if err != nil || !validNugetRequestOrigin(request) {
		return nil, false
	}
	request.Header.Set("User-Agent", "LogBrew public package reconciliation")
	if kind == nugetResponseMetadata {
		request.Header.Set("Accept-Encoding", nugetEncodingGzip)
	}
	response, requestError := client.Do(request)
	if response == nil || response.Body == nil {
		return nil, false
	}
	var data []byte
	valid := false
	if requestError == nil && response.StatusCode == http.StatusOK && !response.Uncompressed &&
		pythonPublicResponseURLMatches(response, address) {
		data, valid = readNugetResponseBody(response, kind, limit)
	}
	closeError := response.Body.Close()
	if !valid || closeError != nil || ctx.Err() != nil {
		return nil, false
	}
	return data, true
}

func validNugetRequestOrigin(request *http.Request) bool {
	return request.URL.Scheme == "https" && request.URL.Host == "api.nuget.org" && request.URL.User == nil
}

func nugetHTTPBounds(kind nugetResponseKind) (int64, time.Duration) {
	switch kind {
	case nugetResponseMetadata:
		return pythonManifestLimit, nugetMetadataTimeout
	case nugetResponsePackage:
		return nugetPackageLimit, maximumDeadline
	default:
		return 0, 0
	}
}

func readNugetResponseBody(response *http.Response, kind nugetResponseKind, limit int64) ([]byte, bool) {
	encodings := response.Header.Values("Content-Encoding")
	if len(encodings) > 1 || len(encodings) != 0 && (kind != nugetResponseMetadata ||
		(encodings[0] != nugetEncodingIdentity && encodings[0] != nugetEncodingGzip)) {
		return nil, false
	}
	compressed := len(encodings) == 1 && encodings[0] == nugetEncodingGzip
	if compressed {
		limit = nugetCompressedLimit
	}
	if response.ContentLength < -1 || response.ContentLength > limit {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil || int64(len(data)) > limit ||
		response.ContentLength >= 0 && int64(len(data)) != response.ContentLength {
		return nil, false
	}
	if compressed {
		return decodeNugetGzip(data)
	}
	return data, true
}

func decodeNugetGzip(data []byte) ([]byte, bool) {
	if len(data) > nugetCompressedLimit {
		return nil, false
	}
	input := bytes.NewReader(data)
	decoder, err := gzip.NewReader(input)
	if err != nil {
		return nil, false
	}
	decoder.Multistream(false)
	body, readError := io.ReadAll(io.LimitReader(decoder, pythonManifestLimit+1))
	closeError := decoder.Close()
	if readError != nil || closeError != nil || len(body) > pythonManifestLimit || input.Len() != 0 {
		return nil, false
	}
	return body, true
}
