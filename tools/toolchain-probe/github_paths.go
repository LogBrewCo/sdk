package main

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

var githubRepositoryName = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]*$`)

type githubSafetyRequest struct {
	repository, branch, environment, requiredContext string
}

func githubSafetyRequestValid(request githubSafetyRequest) bool {
	parts := strings.Split(request.repository, "/")
	if len(parts) != 2 || !githubRepositoryPart(parts[0]) || !githubRepositoryPart(parts[1]) {
		return false
	}
	for _, value := range []string{request.branch, request.environment, request.requiredContext} {
		if !githubSafetyText(value) {
			return false
		}
	}
	for _, selector := range []string{request.branch, request.environment} {
		for segment := range strings.SplitSeq(selector, "/") {
			if segment == "." || segment == ".." {
				return false
			}
		}
	}
	return true
}

func githubRepositoryPart(value string) bool {
	const maximumPart = 100
	if value == "" || value == "." || value == ".." || len(value) > maximumPart || value[0] == '-' {
		return false
	}
	return githubRepositoryName.MatchString(value)
}

func githubSafetyText(value string) bool {
	const maximumText = 1024
	return value != "" && len(value) <= maximumText && utf8.ValidString(value) &&
		strings.TrimSpace(value) == value && !strings.ContainsFunc(value, unicode.IsControl)
}

func githubSafetyPaths(request githubSafetyRequest) []string {
	if !githubSafetyRequestValid(request) {
		return nil
	}
	branch := "repos/" + request.repository + "/branches/" + url.PathEscape(request.branch)
	return []string{
		branch + "/protection", branch,
		"repos/" + request.repository + "/environments/" + url.PathEscape(request.environment),
	}
}
