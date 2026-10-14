package main

import (
	"bytes"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestConfidentialityCommand(t *testing.T) {
	t.Parallel()
	clean := confidentialityFixture(t, map[string]string{"public.txt": "public SDK"})
	flagged := confidentialityFixture(t, map[string]string{confidentialityFixturePath: confidentialityFixtureTerm})
	for _, test := range []struct {
		path, status string
		code         int
	}{
		{clean, confidentialityPassed, exitOK},
		{flagged, confidentialityFailed, exitFailure},
		{filepath.Join(clean, "absent"), confidentialityUnavailable, exitFailure},
	} {
		var output, diagnostic bytes.Buffer
		code := runConfidentiality([]string{test.path}, &output, &diagnostic)
		var report confidentialityReport
		if code != test.code || diagnostic.Len() != 0 ||
			json.Unmarshal(output.Bytes(), &report) != nil || report.Status != test.status ||
			report.SchemaVersion != 1 || strings.Contains(output.String(), confidentialityFixtureTerm) ||
			strings.Contains(output.String(), test.path) {
			t.Fatalf("command returned incorrect or unsafe evidence, code=%d", code)
		}
	}
}

func TestConfidentialityCommandInvalidArguments(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{{"one", "two"}, {""}, {"\n"}, {"path\x00suffix"}} {
		var output, diagnostic bytes.Buffer
		if code := runConfidentiality(arguments, &output, &diagnostic); code != exitUsage ||
			output.Len() != 0 || diagnostic.Len() == 0 {
			t.Fatal("invalid arguments were accepted")
		}
	}
}

type shortCheckOutput struct{}

func (shortCheckOutput) Write(data []byte) (int, error) { return max(0, len(data)-1), nil }

func TestCheckOutputRejectsShortWrites(t *testing.T) {
	t.Parallel()
	if writeText(shortCheckOutput{}, "bounded output", exitOK) != exitFailure {
		t.Fatal("short output write returned success")
	}
}

func TestConfidentialityCommandWriterFailure(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{"public.txt": "public SDK"})
	for _, writer := range []io.Writer{rejectedCheckOutput{}, shortCheckOutput{}} {
		if runConfidentiality([]string{root}, writer, io.Discard) != exitFailure {
			t.Fatal("output failure returned success")
		}
		if runConfidentiality([]string{""}, io.Discard, writer) != exitFailure {
			t.Fatal("diagnostic failure returned a usage result")
		}
	}
}

func TestConfidentialityCommandOutputLimit(t *testing.T) {
	t.Parallel()
	report := scanConfidentiality(t.Context(), confidentialityFixture(t, nil))
	report.FailurePath = strings.Repeat("x", confidentialityOutputLimit)
	var output, diagnostic bytes.Buffer
	if writeConfidentialityReport(&report, &output, &diagnostic) != exitFailure || output.Len() != 0 ||
		diagnostic.String() != "confidentiality output unavailable or over limit\n" {
		t.Fatal("oversized output did not fail with a bounded diagnostic")
	}
}
