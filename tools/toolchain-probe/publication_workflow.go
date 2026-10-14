package main

import (
	"strings"

	"go.yaml.in/yaml/v3"
)

const publicationEnvironmentKey = "env"

func publicationWorkflowNative(data []byte, family string) bool {
	if _, valid := publicationFamilyContract(family); !valid {
		return false
	}
	steps := yamlField(parseMetadataYAML(data), "jobs", family, "steps")
	if !validReconciliationSteps(steps) {
		return false
	}
	built := false
	checked := false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = yamlField(step, "if") == nil
		}
		run := yamlField(step, "run")
		if run == nil || !strings.Contains(run.Value, nativeProbeInvocation+" publication-run") {
			continue
		}
		if checked || !built || yamlField(step, "if") != nil || !publicationWorkflowEnvironment(step, family) {
			return false
		}
		if !publicationWorkflowArguments(run.Value, family) {
			return false
		}
		checked = true
	}
	return checked
}

func publicationWorkflowArguments(run, family string) bool {
	if strings.Count(run, nativeProbeInvocation+" publication-run") != 1 {
		return false
	}
	for _, required := range []string{
		`--repository "$GITHUB_REPOSITORY"`, `--run-id "$PUBLICATION_RUN_ID"`, "--family " + family,
		`--workflow-sha "$PUBLICATION_WORKFLOW_SHA"`, `--source-sha "$RELEASE_SOURCE_SHA"`,
	} {
		if !strings.Contains(run, required) {
			return false
		}
	}
	return true
}

func publicationWorkflowEnvironment(step *yaml.Node, family string) bool {
	return yamlScalar(yamlField(step, publicationEnvironmentKey, "GITHUB_AUTHORIZATION"),
		yamlStringTag, "${{ github.token }}") &&
		yamlScalar(yamlField(step, publicationEnvironmentKey, "PUBLICATION_RUN_ID"), yamlStringTag,
			"${{ inputs."+family+"_publication_run_id }}") &&
		yamlScalar(yamlField(step, publicationEnvironmentKey, "PUBLICATION_WORKFLOW_SHA"), yamlStringTag,
			"${{ inputs.publication_workflow_sha }}") &&
		yamlScalar(yamlField(step, publicationEnvironmentKey, "RELEASE_SOURCE_SHA"), yamlStringTag,
			"${{ steps.release-source.outputs.sha }}")
}
