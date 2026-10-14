package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

const ciStaticMode = "ci-static-duplication"

func runCIStaticDuplication(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "ci-static-duplication requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "CI workflow repository unavailable\n", exitFailure)
	}
	result := ciStaticWorkflowInventory(root, markdownFileLimit, markdownByteLimit)
	if root.Close() != nil {
		result.complete = false
	}
	return writeCIStaticReceipt(output, result)
}

func writeCIStaticReceipt(output io.Writer, result ciStaticInventory) int {
	if result.findings == nil {
		result.findings = []ciStaticFinding{}
	}
	passed := result.complete && len(result.findings) == 0
	receipt := struct {
		Findings []ciStaticFinding `json:"findings"`
		Complete bool              `json:"complete"`
		Passed   bool              `json:"passed"`
	}{Findings: result.findings, Complete: result.complete, Passed: passed}
	if err := json.NewEncoder(output).Encode(receipt); err != nil || !passed {
		return exitFailure
	}
	return exitOK
}
