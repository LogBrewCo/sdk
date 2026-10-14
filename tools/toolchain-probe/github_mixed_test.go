package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

const (
	githubEnvironmentFixtureName = "environment.json"
	githubEnvironmentFixtureFlag = "--environment-json"
	githubSummaryFallbackFlag    = "--allow-public-branch-summary"
)

func TestGitHubMixedEnvironmentFixtureFallback(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{githubEnvironmentFixtureName: string(githubEnvironmentJSON(t))})
	options := githubSafetyOptionsFor([]string{
		githubEnvironmentFixtureFlag, filepath.Join(root, githubEnvironmentFixtureName),
		githubSummaryFallbackFlag,
	})
	calls := 0
	runner := func(_ context.Context, arguments []string) ([]byte, bool) {
		calls++
		path := arguments[len(arguments)-1]
		if strings.HasSuffix(path, "/protection") {
			return nil, false
		}
		if strings.Contains(path, "/environments/") {
			t.Fatal("environment fixture triggered a live environment read")
		}
		return []byte(`{"protected":true,"protection":{"enabled":true,
			"required_status_checks":{"contexts":["Contract checks"]}}}`), true
	}
	result, complete := githubSafetyOptionsExecute(t.Context(), options, runner)
	if !complete || !result.Passed || result.FullProtectionVerified ||
		result.Evidence != githubSummaryEvidence || calls != 2 {
		t.Fatal("mixed fixture fallback changed its evidence or request set")
	}
}

func TestGitHubCancelledFixtureRead(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{githubEnvironmentFixtureName: string(githubEnvironmentJSON(t))})
	options := githubSafetyOptionsFor([]string{
		githubEnvironmentFixtureFlag, filepath.Join(root, githubEnvironmentFixtureName),
	})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	runner := func(context.Context, []string) ([]byte, bool) { called = true; return nil, false }
	result, complete := githubSafetyOptionsExecute(ctx, options, runner)
	if complete || result.Passed || called {
		t.Fatal("cancelled mixed GitHub verification executed")
	}
}
