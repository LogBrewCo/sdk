package main

import (
	"reflect"
	"strings"
	"testing"
)

func githubRequestFixture() githubSafetyRequest {
	return githubSafetyRequest{
		repository: "LogBrewCo/sdk", branch: "trunk",
		environment: "release", requiredContext: githubContractContext,
	}
}

func TestGitHubSafetyPaths(t *testing.T) {
	t.Parallel()
	request := githubRequestFixture()
	request.branch = "release/next?#%"
	request.environment = "release space"
	paths := githubSafetyPaths(request)
	want := []string{
		"repos/LogBrewCo/sdk/branches/release%2Fnext%3F%23%25/protection",
		"repos/LogBrewCo/sdk/branches/release%2Fnext%3F%23%25",
		"repos/LogBrewCo/sdk/environments/release%20space",
	}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("GitHub paths = %v, want %v", paths, want)
	}
}

func TestGitHubSafetyInvalidRequests(t *testing.T) {
	t.Parallel()
	for _, repository := range []string{
		"", "owner", "owner/repo/extra", "../repo", "-owner/repo",
		"owner/repo?query", "owner/repo\n", "owner/",
	} {
		request := githubRequestFixture()
		request.repository = repository
		if githubSafetyPaths(request) != nil {
			t.Fatal("invalid repository reached request planning")
		}
	}
	const oversizedLength = 1025
	for _, value := range []string{"", " main", "main\n", "\xff", strings.Repeat("a", oversizedLength)} {
		for field := range 3 {
			request := githubRequestFixture()
			switch field {
			case 0:
				request.branch = value
			case 1:
				request.environment = value
			default:
				request.requiredContext = value
			}
			if githubSafetyPaths(request) != nil {
				t.Fatal("invalid GitHub selector reached request planning")
			}
		}
	}
}

func TestGitHubSafetyTraversalSelectors(t *testing.T) {
	t.Parallel()
	for _, selector := range []string{"..", "branch/../next", "./branch"} {
		request := githubRequestFixture()
		request.branch = selector
		if githubSafetyPaths(request) != nil {
			t.Fatal("branch traversal reached request planning")
		}
		request = githubRequestFixture()
		request.environment = selector
		if githubSafetyPaths(request) != nil {
			t.Fatal("environment traversal reached request planning")
		}
	}
}
