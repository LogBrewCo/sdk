package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
)

const publicationRunMode = "publication-run"

type publicationRunResult struct {
	identity publicationRunIdentity
	passed   bool
}

func runPublicationRun(arguments []string, output, diagnostic io.Writer) int {
	identity := publicationOptions(arguments)
	if identity == nil {
		return writeText(diagnostic, "Invalid publication-run arguments\n", exitUsage)
	}
	authorization := os.Getenv("GITHUB_AUTHORIZATION")
	if !publicationAuthorizationValid(authorization) {
		return writeText(diagnostic, "Publication authorization unavailable\n", exitFailure)
	}
	client := newRegistryClient(publicationReadTimeout)
	passed := verifyPublicationRun(context.Background(), client, *identity, authorization)
	if client != nil {
		client.CloseIdleConnections()
	}
	return writePublicationRunReceipt(output, &publicationRunResult{identity: *identity, passed: passed})
}

func writePublicationRunReceipt(output io.Writer, result *publicationRunResult) int {
	identity := result.identity
	receipt := struct {
		Repository  string `json:"repository"`
		Family      string `json:"family"`
		WorkflowSHA string `json:"workflow_sha"`
		SourceSHA   string `json:"source_sha"`
		RunID       int64  `json:"run_id"`
		Passed      bool   `json:"passed"`
	}{
		Repository: identity.repository, Family: identity.family, WorkflowSHA: identity.workflowSHA,
		SourceSHA: identity.sourceSHA, RunID: identity.runID, Passed: result.passed,
	}
	if err := json.NewEncoder(output).Encode(receipt); err != nil || !result.passed {
		return exitFailure
	}
	return exitOK
}
