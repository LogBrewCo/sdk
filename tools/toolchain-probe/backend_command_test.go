package main

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestBackendReportCommand(t *testing.T) {
	t.Parallel()
	for _, document := range []string{backendReportFixture, "# Broken report"} {
		root := openMarkdownFixture(t, map[string]string{backendReportDirectory + "/sample.md": document})
		var output, diagnostic bytes.Buffer
		code := runBackendReports([]string{root.Name()}, &output, &diagnostic)
		passed := document == backendReportFixture
		if (code == exitOK) != passed || !strings.Contains(output.String(), `"complete":true`) {
			t.Fatalf("backend report command = %d %s", code, output.String())
		}
	}
}

func TestBackendReportCommandFailures(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{nil, {"relative-report-root"}, {"/tmp", "extra-report-argument"}} {
		if runBackendReports(arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid backend report command accepted")
		}
	}
	incomplete := backendReportInventory{failures: nil, complete: false}
	if writeBackendReports(io.Discard, incomplete) != exitFailure {
		t.Fatal("incomplete backend report inventory passed")
	}
	clean := backendReportInventory{failures: nil, complete: true}
	if writeBackendReports(rejectedCheckOutput{}, clean) != exitFailure {
		t.Fatal("failed backend report receipt write passed")
	}
}
