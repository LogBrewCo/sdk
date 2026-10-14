package main

import (
	"os"
	"strings"

	"go.yaml.in/yaml/v3"
)

const (
	nativeProbeInvocation = `"${LOGBREW_TOOLCHAIN_PROBE_BIN:?}"`
	releaseDispatchFamily = "release-dispatch"
	releaseDispatchPath   = ".github/workflows/publish-release.yml"
)

func checkReleaseDispatch(root *os.Root) bool {
	data, readable := readReleaseMetadata(root, releaseDispatchPath)
	if !readable || !validMetadataText(data, []string{
		"Check out release ref", `if [[ "$RELEASE_TAG" == */* ]]; then`, `publish_packages="false"`,
		`elif [[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then`,
		nativeProbeInvocation + ` repo-wide-versions "$REF" "$GITHUB_WORKSPACE"`,
		"if: ${{ steps.release.outputs.publish_packages == 'true' }}",
		"Skipped package publishing for scoped GitHub Release",
		"maven_artifacts:", `-f maven_artifacts="$MAVEN_ARTIFACTS"`,
		"INPUT_MAVEN_ARTIFACTS: ${{ inputs.maven_artifacts }}", "maven_release_plan.py canonicalize",
		"--artifacts-env INPUT_MAVEN_ARTIFACTS", `printf 'maven_artifacts=%s\n' "$maven_artifacts"`,
		"nuget_packages:", `-f nuget_packages="$NUGET_PACKAGES"`,
		"INPUT_NUGET_PACKAGES: ${{ inputs.nuget_packages }}", nativeProbeInvocation + " nuget-plan canonicalize",
		`printf 'nuget_packages=%s\n' "$nuget_packages"`,
	}) {
		return false
	}
	steps := yamlField(parseMetadataYAML(data), "jobs", "dispatch-publish", "steps")
	if steps == nil || steps.Kind != yaml.SequenceNode {
		return false
	}
	selected := 0
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Resolve release publish inputs") {
			selected++
			script := yamlField(step, "run")
			if script == nil || script.Kind != yaml.ScalarNode || script.Tag != yamlStringTag ||
				!validReleaseDispatchScript(script.Value) {
				return false
			}
		}
	}
	return selected == 1
}

func validReleaseDispatchScript(script string) bool {
	for _, forbidden := range []string{
		"${{ inputs.maven_artifacts }}", "${{ inputs.nuget_packages }}",
		`maven_artifacts="$INPUT_MAVEN_ARTIFACTS"`, `echo "maven_artifacts=$maven_artifacts"`,
		`nuget_packages="$INPUT_NUGET_PACKAGES"`, `echo "nuget_packages=$nuget_packages"`,
	} {
		if strings.Contains(script, forbidden) {
			return false
		}
	}
	return true
}
