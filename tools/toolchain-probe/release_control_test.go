package main

import (
	"io"
	"strings"
	"testing"
)

const protectedControlRef = "ref: ${{ github.workflow_sha }}"
const protectedNativeUses = "uses: ./.release-control/tools/toolchain-probe"

func TestReleaseControlSelectedRoot(t *testing.T) {
	t.Parallel()
	files := map[string]string{
		".github/workflows/publish-packages.yml": repositorySource(t, ".github/workflows/publish-packages.yml"),
		nugetPublicationWorkflow:                 repositorySource(t, nugetPublicationWorkflow),
	}
	root := confidentialityFixture(t, files)
	if runReleaseMetadata([]string{"release-control", root}, io.Discard, io.Discard) != exitOK {
		t.Fatal("valid selected release controls rejected")
	}
	for name, source := range files {
		for _, replacement := range [][2]string{
			{protectedControlRef, "ref: main # ref: ${{ github.workflow_sha }}"},
			{"path: .release-control", "path: .unexpected"},
			{"repository: ${{ github.repository }}", "repository: unrelated/repo"},
			{"RELEASE_CONTROL_SHA: ${{ github.workflow_sha }}", "RELEASE_CONTROL_SHA: invalid"},
			{"- name: Bind protected", "- if: false\n        name: Bind protected"},
			{
				nativeProbeInvocation + " " + registryCommand,
				`"$GITHUB_WORKSPACE/tools/toolchain-probe" registry-publication`,
			},
			{`"$actual_control_sha" != "$RELEASE_CONTROL_SHA"`, `"$actual_control_sha" == "$RELEASE_CONTROL_SHA"`},
		} {
			changed := strings.ReplaceAll(source, replacement[0], replacement[1])
			if changed == source {
				t.Fatal("release-control mutation did not apply")
			}
			files[name] = changed
			root = confidentialityFixture(t, files)
			if runReleaseMetadata([]string{"release-control", root}, io.Discard, io.Discard) == exitOK {
				t.Fatalf("invalid selected release control accepted: %s", name)
			}
			files[name] = source
		}
	}
}

func TestNugetRegistryBootstrapMutations(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, nugetPublicationWorkflow)
	for _, replacement := range [][2]string{
		{protectedNativeUses, "uses: ./tools/toolchain-probe"},
		{nativeProbeInvocation + " " + registryCommand, nativeProbeInvocation + " inventory"},
		{
			"- name: Build protected native release verifier",
			"- if: false\n        name: Build protected native release verifier",
		},
	} {
		changed := strings.ReplaceAll(source, replacement[0], replacement[1])
		steps := yamlField(parseMetadataYAML([]byte(changed)), "jobs", nugetJobName, "steps")
		if validReleaseControlSteps(steps, "release-source", nugetJobName) {
			t.Fatal("invalid native registry bootstrap accepted")
		}
	}
}
