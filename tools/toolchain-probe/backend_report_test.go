package main

import (
	"slices"
	"strings"
	"testing"
)

const backendReportFixture = `# Backend Contract Report: Example
## Status
Backend contract status pending.
## Priority
P1
## User Impact
Release confidence is incomplete.
## Expected Backend Capability
Suggested APIs with event fields.
## SDK Gap Observed
Endpoint is unavailable.
## Verification Needed
Tests and smoke proof for retries.
`

func TestBackendReportValidation(t *testing.T) {
	t.Parallel()
	if failures := backendReportFailures(backendReportFixture); len(failures) != 0 {
		t.Fatalf("valid report rejected: %v", failures)
	}
	for _, test := range []struct{ old, replacement, reason string }{
		{"# Backend Contract Report:", "# Report:", "invalid-title"},
		{"## Priority\nP1\n", "", "missing-section:Priority"},
		{"P1\n", "\n", "empty-section:Priority"},
		{"Backend contract status pending.", "Ready for backend work.", "invalid-status"},
		{"P1\n", "P4\n", "invalid-priority"},
		{"Suggested APIs with event fields.", "Accept telemetry.", "invalid-capability"},
		{"Tests and smoke proof for retries.", "Review behavior.", "invalid-verification"},
	} {
		failures := backendReportFailures(strings.ReplaceAll(backendReportFixture, test.old, test.replacement))
		if !slices.Contains(failures, test.reason) {
			t.Fatalf("report mutation missing %q: %v", test.reason, failures)
		}
	}
}

func TestBackendReportWordBoundaries(t *testing.T) {
	t.Parallel()
	for _, content := range []string{"XP1", "P10", "P1_", "éP1", "P1²"} {
		if backendReportWord(backendPriorityPhrase, content) {
			t.Fatalf("embedded priority accepted: %q", content)
		}
	}
	for _, content := range []string{"P0", "(P1)", "P2/P3"} {
		if !backendReportWord(backendPriorityPhrase, content) {
			t.Fatalf("bounded priority rejected: %q", content)
		}
	}
}

func TestBackendReportCaseMatching(t *testing.T) {
	t.Parallel()
	for _, content := range []string{"SDK-facıng contract", "publİc API contract", "backend contract ſtatus"} {
		if !backendReportWord(backendStatusPhrase, content) {
			t.Fatalf("case-insensitive status rejected: %q", content)
		}
	}
	for _, content := range []string{"VERİFİERS", "verıfıer", "ſmoke"} {
		if !backendReportWord(backendVerificationPhrase, content) {
			t.Fatalf("case-insensitive verification rejected: %q", content)
		}
	}
}
