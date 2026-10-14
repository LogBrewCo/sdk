package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

const backendReportsMode = "backend-reports"

func runBackendReports(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "backend-reports requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "Backend report repository unavailable\n", exitFailure)
	}
	result := backendReports(root, markdownFileLimit, markdownByteLimit)
	if root.Close() != nil {
		result.complete = false
	}
	return writeBackendReports(output, result)
}

func writeBackendReports(output io.Writer, result backendReportInventory) int {
	type finding struct {
		Source string `json:"source"`
		Reason string `json:"reason"`
	}
	findings := make([]finding, 0, len(result.failures))
	for _, failure := range result.failures {
		findings = append(findings, finding{Source: failure.source, Reason: failure.reason})
	}
	passed := result.complete && len(findings) == 0
	receipt := struct {
		Findings []finding `json:"findings"`
		Complete bool      `json:"complete"`
		Passed   bool      `json:"passed"`
	}{Findings: findings, Complete: result.complete, Passed: passed}
	if err := json.NewEncoder(output).Encode(receipt); err != nil || !passed {
		return exitFailure
	}
	return exitOK
}
