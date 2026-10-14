package main

import (
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHubSummaryFixtureCommand(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		"summary.json": `{"protected":true,"protection":{"enabled":true,
			"required_status_checks":{"contexts":["Contract checks"]}}}`,
		githubEnvironmentFixtureName: string(githubEnvironmentJSON(t)),
	})
	arguments := []string{
		"--branch-summary-json=" + filepath.Join(root, "summary.json"),
		githubEnvironmentFixtureFlag, filepath.Join(root, githubEnvironmentFixtureName),
	}
	var output strings.Builder
	if runGitHubSafety(arguments, &output, io.Discard) != exitOK {
		t.Fatal("explicit summary fixture command failed")
	}
	var result githubSafetyResult
	if err := json.Unmarshal([]byte(output.String()), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Passed || result.FullProtectionVerified || result.Evidence != githubSummaryEvidence {
		t.Fatal("summary fixture command upgraded its evidence")
	}
}
