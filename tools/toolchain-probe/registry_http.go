package main

import (
	"context"
	"io"
	"net/http"
	"unicode/utf8"
)

const registryHTTPStatusReason = "http-status"

type registryResponse struct {
	versions map[string]bool
	reason   string
	status   int
	readable bool
}

func fetchRegistryResponse(ctx context.Context, client *http.Client, plan registryRequest) registryResponse {
	result := registryResponse{versions: nil, status: 0, readable: false, reason: "invalid-request"}
	if client == nil || plan.extract == nil {
		return result
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, plan.address, http.NoBody)
	if err != nil {
		return result
	}
	request.Header.Set("User-Agent", "LogBrew public registry verifier")
	result.reason = "transport-failed"
	response, err := client.Do(request)
	if err != nil {
		return result
	}
	result.status = response.StatusCode
	result.reason = registryHTTPStatusReason
	if result.status != http.StatusOK {
		if response.Body.Close() != nil {
			result.status = 0
			result.reason = "response-close-failed"
		}
		return result
	}
	result.reason = "response-unreadable"
	data, readError := io.ReadAll(io.LimitReader(response.Body, pythonManifestLimit+1))
	closeError := response.Body.Close()
	if readError != nil || closeError != nil || len(data) > pythonManifestLimit || !utf8.Valid(data) {
		return result
	}
	var payload any = string(data)
	if !plan.text {
		result.reason = "invalid-json"
		decoded, valid := decodeCheckDocument(data)
		if !valid {
			return result
		}
		payload = decoded
	}
	result.versions, result.readable = plan.extract(payload), true
	result.reason = "versions-read"
	return result
}
