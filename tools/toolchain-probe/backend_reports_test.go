package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const validBackendReport = `# Backend Contract Report: Example - 2026-06-14

## Status

Backend contract status is pending for the SDK-facing API shape.

## Priority

P1 - Blocks release confidence for the affected SDK workflow.

## User Impact

Developers cannot trust this workflow in production until the backend supports it.

### Detail

A level-three heading stays inside its section.

## Expected Backend Capability

Suggested APIs:

- ` + "`POST /api/example`" + ` with event fields ` + "`release`" + `.

## SDK Gap Observed

The SDK can prepare data locally, but there is no backend endpoint to accept it.

## Verification Needed

- Unit tests for validation failure.
`

func writeBackendReports(t *testing.T, reports map[string]string) string {
	t.Helper()
	root := t.TempDir()
	directory := filepath.Join(root, backendReportDir)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, text := range reports {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestBackendReportsAcceptRepositoryAndValidReport(t *testing.T) {
	t.Parallel()
	for _, root := range []string{"../..", writeBackendReports(t, map[string]string{"example.md": validBackendReport})} {
		var output, diagnostic bytes.Buffer
		if code := checkBackendReports([]string{root}, &output, &diagnostic); code != exitOK ||
			output.String() != "backend contract reports ok\n" {
			t.Fatalf("%s: code %d: %s", root, code, diagnostic.String())
		}
	}
}

func TestBackendReportsReportEachFailureClass(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ old, replacement, want string }{
		{"# Backend Contract Report:", "# Report:", "title must start with '# Backend Contract Report:'"},
		{"## Priority\n\nP1 - Blocks release confidence for the affected SDK workflow.\n\n", "",
			"missing required '## Priority' section"},
		{"Developers cannot trust this workflow in production until the backend supports it.\n\n### Detail\n\nA level-three heading stays inside its section.\n", "",
			"'## User Impact' section must not be empty"},
		{"Backend contract status is pending for the SDK-facing API shape.", "Ready.",
			"Status must state SDK-facing backend contract status"},
		{"P1 - Blocks", "Blocks", "Priority must include P0, P1, P2, or P3"},
		{"Suggested APIs:\n\n- `POST /api/example` with event fields `release`.", "Something.",
			"Expected Backend Capability must include suggested APIs, event fields, or runtime matching fields"},
		{"- Unit tests for validation failure.", "- Later.",
			"Verification Needed must include concrete test, verifier, proof, or smoke expectations"},
	} {
		text := strings.Replace(validBackendReport, test.old, test.replacement, 1)
		if got := backendReportProblems(text); !slices.Contains(got, test.want) {
			t.Errorf("%q: problems %q", test.want, got)
		}
	}
}

func TestBackendReportsRejectMissingOrEmptyDirectory(t *testing.T) {
	t.Parallel()
	if got := backendReportFailures(t.TempDir()); len(got) != 1 || !strings.HasPrefix(got[0], "missing backend contract report directory") {
		t.Fatalf("missing directory: %q", got)
	}
	if got := backendReportFailures(writeBackendReports(t, nil)); len(got) != 1 || !strings.HasPrefix(got[0], "no backend contract reports") {
		t.Fatalf("empty directory: %q", got)
	}
	root := writeBackendReports(t, map[string]string{"a.md": "# Other\n", "b.md": validBackendReport})
	var output, diagnostic bytes.Buffer
	if code := checkBackendReports([]string{root}, &output, &diagnostic); code != exitFailure ||
		!strings.HasPrefix(diagnostic.String(), "docs/backend-contracts/a.md: title must start") {
		t.Fatalf("code %d: %q", code, diagnostic.String())
	}
	if code := checkBackendReports(nil, &output, &diagnostic); code != exitUsage {
		t.Fatalf("usage code %d", code)
	}
}

// The reports keep the commitments SDKs rely on.
func TestBackendReportsKeepSDKCommitments(t *testing.T) {
	t.Parallel()
	for name, phrases := range map[string][]string{
		"release-artifact-symbolication-2026-06-13.md": {
			"React Native-shaped Android mapping/native `.so`",
			"iOS `.xcarchive/dSYMs`",
			"auth-gated release-artifact upload, lookup, byte retention, and one-frame JavaScript symbolication are deployed",
			"real hosted minified/native symbolicated-error proof",
			"native/mobile hosted upload support remain incomplete",
			"explicit JavaScript release-artifact hosted upload opt-in",
		},
		"support-ticket-routes-2026-06-24.md": {
			"Backend contract status is pending for SDK network calls",
			"safe for SDK network calls yet",
			"redacted live verification",
			"SDKs must not call `POST /api/support/tickets`",
			"explicit local diagnostics draft",
		},
	} {
		data, err := os.ReadFile(filepath.Join("../..", backendReportDir, name))
		if err != nil {
			t.Fatal(err)
		}
		for _, phrase := range phrases {
			if !strings.Contains(string(data), phrase) {
				t.Errorf("%s: missing %q", name, phrase)
			}
		}
	}
	data, _ := os.ReadFile(filepath.Join("../..", backendReportDir, "release-artifact-symbolication-2026-06-13.md"))
	if strings.Contains(string(data), "no backend release-artifact route/schema/lookup surface") {
		t.Error("release artifact report still says the backend has no route")
	}
}
