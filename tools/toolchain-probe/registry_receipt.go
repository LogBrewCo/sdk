package main

import (
	"encoding/json"
	"io"
)

type registryReceiptEntry struct {
	Family           string   `json:"family"`
	Package          string   `json:"package"`
	Reason           string   `json:"reason"`
	ExpectedVersions []string `json:"expected_versions"`
	HTTPStatus       int      `json:"http_status"`
	Attempts         int      `json:"attempts"`
	Passed           bool     `json:"passed"`
}

type registryReceipt struct {
	Checks         []registryReceiptEntry `json:"checks"`
	Complete       bool                   `json:"complete"`
	Passed         bool                   `json:"passed"`
	ExpectedChecks int                    `json:"expected_checks"`
}

func writeRegistryReceipt(output io.Writer, results []registryCheckResult, expected int, complete bool) int {
	entries := make([]registryReceiptEntry, 0, len(results))
	for _, result := range results {
		entry := registryReceiptEntry{
			Family: result.family, Package: result.label, Passed: result.passed,
			ExpectedVersions: result.expected,
			Reason:           result.outcome.reason,
			HTTPStatus:       result.outcome.status,
			Attempts:         result.outcome.attempts,
		}
		entries = append(entries, entry)
	}
	complete = complete && expected >= 0 && len(results) == expected
	receipt := registryReceipt{
		Checks: entries, Complete: complete, Passed: complete && registryResultsPassed(results),
		ExpectedChecks: expected,
	}
	if err := json.NewEncoder(output).Encode(receipt); err != nil {
		return exitFailure
	}
	if !receipt.Passed {
		return exitFailure
	}
	return exitOK
}
