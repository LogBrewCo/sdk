package main

import (
	"io"
	"strings"
	"testing"
)

const dispatchMissingMutation = "missing-workflow"

func TestReleaseDispatchMetadataSelectedRoot(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, releaseDispatchPath)
	for _, mutation := range []string{
		"", dispatchMissingMutation, "scoped", "version-guard", "nuget-selector", "maven-selector",
		"interpolation", "uncanonical",
	} {
		changed := source
		switch mutation {
		case "", dispatchMissingMutation:
		case "scoped":
			changed = strings.Replace(source, `publish_packages="false"`, `publish_packages="true"`, 1)
		case "version-guard":
			changed = strings.Replace(source, "repo-wide-versions", "omitted", 1)
		case "nuget-selector":
			changed = strings.Replace(source, "nuget-plan canonicalize", "omitted", 1)
		case "maven-selector":
			changed = strings.Replace(source, "maven_release_plan.py canonicalize", "omitted", 1)
		case "interpolation":
			changed = strings.Replace(source, `ref="$INPUT_REF"`, `ref="${{ inputs.nuget_packages }}"`, 1)
		case "uncanonical":
			changed = strings.Replace(source, `ref="$INPUT_REF"`, `nuget_packages="$INPUT_NUGET_PACKAGES"`, 1)
		default:
			t.Fatal("unknown dispatch mutation")
		}
		files := map[string]string{}
		if mutation != dispatchMissingMutation {
			files[releaseDispatchPath] = changed
		}
		root := confidentialityFixture(t, files)
		if mutation != "" && mutation != dispatchMissingMutation && changed == source {
			t.Fatal("dispatch mutation did not apply")
		}
		status := runReleaseMetadata([]string{releaseDispatchFamily, root}, io.Discard, io.Discard)
		if (status == exitOK) != (mutation == "") {
			t.Errorf("selected-root dispatch result incorrect for %q: %d", mutation, status)
		}
	}
}
