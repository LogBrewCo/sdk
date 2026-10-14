package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/url"
)

const (
	jsNativeReleaseURL    = "https://github.com/oxc-project/oxc/releases/download/oxlint_v1.86.0/"
	jsNativeRedirectLimit = 3
	jsNativeHTTPS         = "https"
)

func jsNativeRedirectAllowed(address *url.URL) bool {
	return address != nil && address.Scheme == jsNativeHTTPS && address.User == nil && address.Port() == "" &&
		address.Host == "release-assets.githubusercontent.com" && address.Fragment == ""
}

func jsNativeDownloadClient() *http.Client {
	client := newRegistryClient(jsSyntaxTimeout)
	if client == nil {
		return nil
	}
	client.CheckRedirect = func(request *http.Request, previous []*http.Request) error {
		if len(previous) > jsNativeRedirectLimit || !jsNativeRedirectAllowed(request.URL) {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return client
}

func jsNativeArchiveKnown(specification jsNativeArchive) bool {
	for _, platform := range []string{"darwin/arm64", "darwin/amd64", "linux/arm64", "linux/amd64"} {
		known, valid := jsNativeArchiveForPlatform(platform)
		if valid && known == specification {
			return true
		}
	}
	return false
}

func jsNativeDownload(ctx context.Context, client *http.Client, specification jsNativeArchive) ([]byte, bool) {
	if client == nil || !jsNativeArchiveKnown(specification) {
		return nil, false
	}
	ctx, cancel := context.WithTimeout(ctx, jsSyntaxTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, jsNativeReleaseURL+specification.name, http.NoBody)
	if err != nil {
		return nil, false
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, false
	}
	if response.StatusCode != http.StatusOK || response.ContentLength > markdownByteLimit {
		if response.Body.Close() != nil {
			return nil, false
		}
		return nil, false
	}
	data, readError := io.ReadAll(io.LimitReader(response.Body, markdownByteLimit+1))
	closeError := response.Body.Close()
	digest := sha256.Sum256(data)
	if readError != nil || closeError != nil || ctx.Err() != nil || response.StatusCode != http.StatusOK ||
		response.ContentLength > markdownByteLimit || len(data) > markdownByteLimit ||
		hex.EncodeToString(digest[:]) != specification.digest {
		return nil, false
	}
	return data, true
}
