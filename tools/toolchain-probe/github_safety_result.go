package main

import (
	"encoding/json"
	"io"
)

const (
	githubFullEvidence    = "full-protection"
	githubSummaryEvidence = "public-summary"
)

type githubSafetyResult struct {
	Evidence               string `json:"branch_evidence"`
	BranchValid            bool   `json:"branch_valid"`
	EnvironmentValid       bool   `json:"environment_valid"`
	FullProtectionVerified bool   `json:"full_protection_verified"`
	Passed                 bool   `json:"passed"`
}

func githubSafetyEvaluate(branch, environment any,
	evidence, environmentName, requiredContext string,
) githubSafetyResult {
	result := githubSafetyResult{
		Evidence: evidence, BranchValid: false, EnvironmentValid: false,
		FullProtectionVerified: false, Passed: false,
	}
	switch evidence {
	case githubFullEvidence:
		result.BranchValid = githubFullProtection(branch, requiredContext)
		result.FullProtectionVerified = result.BranchValid
	case githubSummaryEvidence:
		result.BranchValid = githubPublicSummary(branch, requiredContext)
	default:
		return result
	}
	result.EnvironmentValid = githubReleaseEnvironment(environment, environmentName)
	result.Passed = result.BranchValid && result.EnvironmentValid
	return result
}

func writeGitHubSafetyResult(output io.Writer, result githubSafetyResult) int {
	if err := json.NewEncoder(output).Encode(result); err != nil {
		return exitFailure
	}
	if !result.Passed {
		return exitFailure
	}
	return exitOK
}
