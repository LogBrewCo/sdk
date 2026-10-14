package main

import "testing"

func TestGitHubSafetyOptions(t *testing.T) {
	t.Parallel()
	defaults := githubSafetyOptionsFor(nil)
	if defaults == nil || defaults.request.branch != githubDefaultBranch || defaults.fallback != githubFullEvidence {
		t.Fatal("default GitHub full protection changed")
	}
	options := githubSafetyOptionsFor([]string{
		"--repo=owner/project", "--branch", "release/next",
		"--environment", "preproduction", "--required-context", "Build", githubSummaryFallbackFlag,
	})
	if options == nil || options.request.repository != "owner/project" || options.request.branch != "release/next" ||
		options.request.environment != "preproduction" || options.request.requiredContext != "Build" ||
		options.fallback != githubSummaryEvidence {
		t.Fatal("GitHub options lost their exact bindings")
	}
}

func TestGitHubSafetyInvalidOptions(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		{"--unrecognized-github-flag"},
		{"--repo"},
		{"--repo="},
		{"positional"},
		{"--allow-public-branch-summary=true"},
		{"--branch", "../unowned"},
		{"--branch-summary-json", "relative.json"},
		{"--branch-protection-json", "/tmp/full.json", "--branch-summary-json", "/tmp/summary.json"},
	} {
		if githubSafetyOptionsFor(arguments) != nil {
			t.Fatalf("invalid options accepted: %v", arguments)
		}
	}
}
