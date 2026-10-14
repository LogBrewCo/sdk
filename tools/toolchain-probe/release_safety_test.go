package main

import (
	"io"
	"strings"
	"testing"
)

func TestReleaseSafetySelectedRoot(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		nugetPlanSourcePath:   repositorySource(t, nugetPlanSourcePath),
		aspnetPublicSmokePath: repositorySource(t, aspnetPublicSmokePath),
		githubActionsDocPath:  repositorySource(t, githubActionsDocPath),
		trustedPublishersPath: repositorySource(t, trustedPublishersPath),
	}
	assertReleaseMetadataFiles(t, releaseSafetyFamily, files)
	root := confidentialityFixture(t, files)
	if runReleaseMetadata([]string{releaseSafetyFamily, root}, io.Discard, io.Discard) != exitOK {
		t.Fatal("selected-root release safety rejected")
	}
	for _, omitted := range []string{
		"release tag's commit", "historical tags", "repo-wide-versions", pythonFlaskID, "dotnetMetadataPackages()",
	} {
		changed := make(map[string]string)
		for path, text := range files {
			changed[path] = strings.ReplaceAll(text, omitted, "omitted-safety-proof")
		}
		root = confidentialityFixture(t, changed)
		if runReleaseMetadata([]string{releaseSafetyFamily, root}, io.Discard, io.Discard) == exitOK {
			t.Errorf("missing release safety accepted: %s", omitted)
		}
	}
}
