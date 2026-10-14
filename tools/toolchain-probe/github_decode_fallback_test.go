package main

import (
	"context"
	"path/filepath"
	"testing"
)

func TestGitHubMalformedResponseCannotFallback(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{githubEnvironmentFixtureName: string(githubEnvironmentJSON(t))})
	options := githubSafetyOptionsFor([]string{
		githubEnvironmentFixtureFlag, filepath.Join(root, githubEnvironmentFixtureName), githubSummaryFallbackFlag,
	})
	for _, data := range []string{"invalid-response", `{"duplicate":1,"duplicate":2}`} {
		calls := 0
		runner := func(context.Context, []string) ([]byte, bool) { calls++; return []byte(data), true }
		result, complete := githubSafetyOptionsExecute(t.Context(), options, runner)
		if complete || result.Passed || result.Evidence != githubFullEvidence || calls != 1 {
			t.Fatal("mixed malformed full response triggered a fallback")
		}
		calls = 0
		result, complete = githubSafetyExecute(t.Context(), options.request, githubSummaryEvidence, runner)
		if complete || result.Passed || result.Evidence != githubFullEvidence || calls != 1 {
			t.Fatal("malformed full response triggered a fallback")
		}
	}
}
