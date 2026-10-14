package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestGitHubFallbackCannotHideUnsafeProtection(t *testing.T) {
	t.Parallel()
	branch := githubProtectionFixture(t)
	eventObject(branch["required_status_checks"])["strict"] = false
	branchJSON, err := json.Marshal(branch)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	runner := func(_ context.Context, arguments []string) ([]byte, bool) {
		calls++
		if strings.HasSuffix(arguments[len(arguments)-1], "/protection") {
			return branchJSON, true
		}
		return githubEnvironmentJSON(t), true
	}
	result, complete := githubSafetyExecute(t.Context(), githubRequestFixture(), githubSummaryEvidence, runner)
	if !complete || result.Passed || result.Evidence != githubFullEvidence || calls != 2 {
		t.Fatal("fallback hid unsafe full protection")
	}
}

func githubEnvironmentJSON(t *testing.T) []byte {
	t.Helper()
	data, err := json.Marshal(githubEnvironmentFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestGitHubSummaryFallbackIsExplicit(t *testing.T) {
	t.Parallel()
	assertGitHubFallbackPolicy(t, githubFullEvidence)
	assertGitHubFallbackPolicy(t, githubSummaryEvidence)
}

func assertGitHubFallbackPolicy(t *testing.T, policy string) {
	t.Helper()
	calls := 0
	runner := func(_ context.Context, arguments []string) ([]byte, bool) {
		calls++
		path := arguments[len(arguments)-1]
		if strings.HasSuffix(path, "/protection") {
			return nil, false
		}
		if strings.Contains(path, "/environments/") {
			return githubEnvironmentJSON(t), true
		}
		return []byte(`{"protected":true,"protection":{"enabled":true,
				"required_status_checks":{"contexts":["Contract checks"]}}}`), true
	}
	result, complete := githubSafetyExecute(t.Context(), githubRequestFixture(), policy, runner)
	if policy == githubFullEvidence {
		if complete || result.Passed || calls != 1 {
			t.Fatal("strict mode used a fallback")
		}
	} else if !complete || !result.Passed || result.FullProtectionVerified ||
		result.Evidence != githubSummaryEvidence || calls != 3 {
		t.Fatal("explicit summary fallback lost its evidence level")
	}
}
