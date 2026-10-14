package main

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHubSafetyFixtureCommand(t *testing.T) {
	t.Parallel()
	branch, err := json.Marshal(githubProtectionFixture(t))
	if err != nil {
		t.Fatal(err)
	}
	root := confidentialityFixture(t, map[string]string{
		"branch.json": string(branch), githubEnvironmentFixtureName: string(githubEnvironmentJSON(t)),
	})
	arguments := []string{
		"--branch-protection-json", filepath.Join(root, "branch.json"),
		githubEnvironmentFixtureFlag, filepath.Join(root, githubEnvironmentFixtureName),
	}
	var output strings.Builder
	if runGitHubSafety(arguments, &output, io.Discard) != exitOK {
		t.Fatal("full fixture command failed")
	}
	var result githubSafetyResult
	if err := json.Unmarshal([]byte(output.String()), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Passed || !result.FullProtectionVerified {
		t.Fatal("full fixture lost its evidence level")
	}
	if runGitHubSafety(arguments, rejectedCheckOutput{}, io.Discard) != exitFailure {
		t.Fatal("GitHub command accepted output failure")
	}
}

func TestGitHubFixtureFailureCannotReadLive(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{"invalid.json": "not-json"})
	options := githubSafetyOptionsFor([]string{
		"--branch-protection-json=" + filepath.Join(root, "invalid.json"),
		githubSummaryFallbackFlag,
	})
	called := false
	runner := func(context.Context, []string) ([]byte, bool) { called = true; return nil, false }
	result, complete := githubSafetyOptionsExecute(t.Context(), options, runner)
	if complete || result.Passed || called {
		t.Fatal("invalid branch fixture triggered a live fallback")
	}
}
