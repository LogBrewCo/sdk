package main

import (
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	publicationReadRun     = "run"
	publicationReadTimeout = 30 * time.Second
)

func publicationRunRead(ctx context.Context, client *http.Client, identity publicationRunIdentity,
	authorization, kind string,
) (any, bool) {
	if client == nil || ctx.Err() != nil || !publicationIdentityValid(identity) ||
		!publicationAuthorizationValid(authorization) {
		return nil, false
	}
	address := publicationReadAddress(identity, kind)
	if address == "" {
		return nil, false
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, http.NoBody)
	if err != nil {
		return nil, false
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+authorization)
	request.Header.Set("X-Github-Api-Version", "2022-11-28")
	request.Header.Set("User-Agent", "LogBrew publication verifier")
	bounded := *client
	bounded.Timeout = publicationReadTimeout
	bounded.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := bounded.Do(request)
	if err != nil {
		return nil, false
	}
	data, readError := io.ReadAll(io.LimitReader(response.Body, pythonManifestLimit+1))
	closeError := response.Body.Close()
	if response.StatusCode != http.StatusOK || readError != nil || closeError != nil ||
		len(data) > pythonManifestLimit || !utf8.Valid(data) || ctx.Err() != nil {
		return nil, false
	}
	document, valid := decodeCheckDocument(data)
	_, object := document.(map[string]any)
	return document, valid && object
}

func publicationReadAddress(identity publicationRunIdentity, kind string) string {
	address := "https://api.github.com/repos/" + identity.repository +
		"/actions/runs/" + strconv.FormatInt(identity.runID, 10)
	switch kind {
	case publicationReadRun:
		return address
	case "jobs":
		return address + "/jobs?per_page=100"
	default:
		return ""
	}
}

func publicationAuthorizationValid(value string) bool {
	return value != "" && !strings.ContainsFunc(value, unicode.IsSpace) &&
		!strings.ContainsFunc(value, unicode.IsControl)
}
