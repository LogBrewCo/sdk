package main

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"time"
	"unicode"
)

const (
	confidentialityTimeout     = 18 * time.Second
	confidentialityOutputLimit = 1 << 20
)

func runConfidentiality(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) > 1 || len(arguments) == 1 &&
		(strings.TrimSpace(arguments[0]) == "" || strings.ContainsFunc(arguments[0], unicode.IsControl)) {
		return writeText(diagnostic, "confidentiality-check accepts at most one directory\n", exitUsage)
	}
	directory := "."
	if len(arguments) == 1 {
		directory = arguments[0]
	}
	ctx, cancel := context.WithTimeout(context.Background(), confidentialityTimeout)
	defer cancel()
	report := scanConfidentiality(ctx, directory)
	return writeConfidentialityReport(&report, output, diagnostic)
}

func writeConfidentialityReport(report *confidentialityReport, output, diagnostic io.Writer) int {
	data, err := json.Marshal(report)
	if err != nil || len(data) >= confidentialityOutputLimit {
		return writeText(diagnostic, "confidentiality output unavailable or over limit\n", exitFailure)
	}
	code := exitFailure
	if report.Status == confidentialityPassed {
		code = exitOK
	}
	return writeText(output, string(data)+"\n", code)
}
