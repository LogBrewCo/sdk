package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGitHubSafetyEvidenceReceipt(t *testing.T) {
	t.Parallel()
	full := githubProtectionFixture(t)
	summary := map[string]any{
		"protected": true, "protection": map[string]any{
			githubProtectionEnabled:  true,
			"required_status_checks": map[string]any{githubStatusContexts: []any{githubContractContext}},
		},
	}
	for _, test := range []struct {
		branch       any
		environment  any
		evidence     string
		passed, full bool
	}{
		{full, githubEnvironmentFixture(t), githubFullEvidence, true, true},
		{summary, githubEnvironmentFixture(t), githubSummaryEvidence, true, false},
		{summary, githubEnvironmentFixture(t), githubFullEvidence, false, false},
		{full, nil, githubFullEvidence, false, true},
		{full, githubEnvironmentFixture(t), "unknown-evidence", false, false},
	} {
		result := githubSafetyEvaluate(test.branch, test.environment,
			test.evidence, "release", githubContractContext)
		var output strings.Builder
		code := writeGitHubSafetyResult(&output, result)
		var receipt githubSafetyResult
		if err := json.Unmarshal([]byte(output.String()), &receipt); err != nil {
			t.Fatal(err)
		}
		if (code == exitOK) != test.passed || receipt.Passed != test.passed ||
			receipt.FullProtectionVerified != test.full || receipt.Evidence != test.evidence {
			t.Fatalf("incorrect protection receipt: %s", output.String())
		}
	}
	result := githubSafetyEvaluate(full, githubEnvironmentFixture(t),
		githubFullEvidence, "release", githubContractContext)
	if writeGitHubSafetyResult(rejectedCheckOutput{}, result) != exitFailure {
		t.Fatal("protection receipt accepted output failure")
	}
}
