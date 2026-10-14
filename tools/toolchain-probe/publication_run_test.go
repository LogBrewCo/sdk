package main

import (
	"encoding/json"
	"testing"
)

func publicationRunFixture() (map[string]any, publicationRunIdentity) {
	const fixtureRunID = 42
	identity := publicationRunIdentity{
		repository: "LogBrewCo/sdk", family: nugetJobName, workflowSHA: "workflow-revision",
		sourceSHA: "source-revision", runID: fixtureRunID,
	}
	return map[string]any{
		"id": json.Number("42"), "run_attempt": json.Number("1"), "event": "workflow_dispatch",
		publicationPathKey: publishWorkflowPath, "head_branch": githubDefaultBranch, "head_sha": identity.workflowSHA,
		"display_title": "Publish nuget from " + identity.sourceSHA, "conclusion": publicationFailure,
		"head_repository": map[string]any{"full_name": identity.repository},
		"referenced_workflows": []any{map[string]any{
			publicationPathKey: identity.repository + "/.github/workflows/publish-nuget.yml@" + identity.workflowSHA,
			"ref":              "refs/heads/main", "sha": identity.workflowSHA,
		}},
	}, identity
}

func TestPublicationRunIdentity(t *testing.T) {
	t.Parallel()
	run, identity := publicationRunFixture()
	if !publicationRunMatches(run, identity) {
		t.Fatal("bound publication run rejected")
	}
	for _, key := range []string{
		"id", "run_attempt", "event", publicationPathKey, "head_branch", "head_sha",
		"display_title", "conclusion", "head_repository", "referenced_workflows",
	} {
		modified, expected := publicationRunFixture()
		modified[key] = nil
		if publicationRunMatches(modified, expected) {
			t.Fatalf("publication run accepted missing %s", key)
		}
	}
}

func TestPublicationRunNumber(t *testing.T) {
	t.Parallel()
	for _, value := range []any{true, "1", json.Number("1.0"), json.Number("1e0"), json.Number("2")} {
		if publicationRunNumber(value, 1) {
			t.Fatalf("nonexact publication integer accepted: %v", value)
		}
	}
}
