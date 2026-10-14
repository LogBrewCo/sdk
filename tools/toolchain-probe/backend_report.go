package main

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	backendStatusSection       = "Status"
	backendPrioritySection     = "Priority"
	backendExpectedSection     = "Expected Backend Capability"
	backendVerificationSection = "Verification Needed"
)

var (
	backendStatusPhrase = regexp.MustCompile(`(?i)backend contract status|` +
		`SDK-facing contract|public API contract`)
	backendPriorityPhrase     = regexp.MustCompile(`P[0-3]`)
	backendVerificationPhrase = regexp.MustCompile(`(?i)tests?|verifiers?|proof|smoke`)
)

func backendReportFailures(document string) []string {
	failures := []string{}
	if !strings.HasPrefix(document, "# Backend Contract Report:") {
		failures = append(failures, "invalid-title")
	}
	sections := backendReportSections(document)
	for _, section := range []string{
		backendStatusSection, backendPrioritySection, "User Impact",
		backendExpectedSection, "SDK Gap Observed", backendVerificationSection,
	} {
		content, present := sections[section]
		if !present {
			failures = append(failures, "missing-section:"+section)
		} else if content == "" {
			failures = append(failures, "empty-section:"+section)
		}
	}
	for _, rule := range []struct {
		pattern *regexp.Regexp
		section string
		reason  string
	}{
		{backendStatusPhrase, backendStatusSection, "invalid-status"},
		{backendPriorityPhrase, backendPrioritySection, "invalid-priority"},
		{backendVerificationPhrase, backendVerificationSection, "invalid-verification"},
	} {
		if content := sections[rule.section]; content != "" && !backendReportWord(rule.pattern, content) {
			failures = append(failures, rule.reason)
		}
	}
	if content := sections[backendExpectedSection]; content != "" && !backendExpectedCapability(content) {
		failures = append(failures, "invalid-capability")
	}
	return failures
}

func backendExpectedCapability(content string) bool {
	for _, marker := range []string{"Suggested APIs", "Suggested API", "event", "fields", "Runtime telemetry"} {
		if strings.Contains(content, marker) {
			return true
		}
	}
	return false
}

func backendReportWord(pattern *regexp.Regexp, content string) bool {
	if pattern != backendPriorityPhrase {
		content = strings.Map(backendCaseRune, content)
	}
	for _, match := range pattern.FindAllStringIndex(content, -1) {
		before, _ := utf8.DecodeLastRuneInString(content[:match[0]])
		after, _ := utf8.DecodeRuneInString(content[match[1]:])
		if !backendWordCharacter(before) && !backendWordCharacter(after) {
			return true
		}
	}
	return false
}

func backendCaseRune(value rune) rune {
	if value == 'İ' || value == 'ı' {
		return 'i'
	}
	return value
}

func backendWordCharacter(value rune) bool {
	return value == '_' || unicode.IsLetter(value) || unicode.IsNumber(value)
}
