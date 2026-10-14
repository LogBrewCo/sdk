package main

import (
	"os"
	"strings"

	"go.yaml.in/yaml/v3"
)

const (
	nugetJobName             = "nuget"
	releaseControlFamily     = "release-control"
	nugetPublicationWorkflow = ".github/workflows/publish-nuget.yml"
	workflowRefKey           = "ref"
	workflowRepositoryKey    = "repository"
	releaseVerifyJob         = "verify"
)

type releaseControlOrder struct {
	source, sourceBinding, control, binding int
}

func checkReleaseControl(root *os.Root) bool {
	for path, jobs := range map[string][]string{
		".github/workflows/publish-packages.yml": {releaseVerifyJob, "verify-swiftpm"},
		nugetPublicationWorkflow:                 {nugetJobName},
	} {
		data, readable := readReleaseMetadata(root, path)
		document := parseMetadataYAML(data)
		if !readable || document == nil {
			return false
		}
		for _, job := range jobs {
			sourceID := "verify-source"
			if job == nugetJobName {
				sourceID = "release-source"
			}
			if !validReleaseControlSteps(yamlField(document, "jobs", job, "steps"), sourceID, job) {
				return false
			}
		}
	}
	return true
}

func validReleaseControlSteps(steps *yaml.Node, sourceID, job string) bool {
	if steps == nil || steps.Kind != yaml.SequenceNode {
		return false
	}
	var order releaseControlOrder
	verified := 0
	built := false
	scriptName, expected := "real_user_swiftpm_public_smoke.sh", 1
	switch job {
	case nugetJobName:
		expected = 2
	default:
		// Registry verification uses one protected checker execution.
	}
	for _, step := range steps.Content {
		if !order.acceptStep(step, sourceID) {
			return false
		}
		build := releaseControlNativeBuild(step, job, order.binding, built)
		built = build.built
		if !build.valid {
			return false
		}
		if script := yamlField(step, "run"); script != nil {
			count, valid := releaseControlVerifierCount(script.Value, scriptName, job, built, order.binding)
			if !valid {
				return false
			}
			verified += count
		}
	}
	return validReleaseControlOrder(order) && verified == expected
}

type releaseControlBuild struct {
	built, valid bool
}

func releaseControlNativeBuild(step *yaml.Node, job string, binding int, built bool) releaseControlBuild {
	if (job == nugetJobName || job == releaseVerifyJob) && yamlScalar(yamlField(step, "uses"), yamlStringTag,
		"./.release-control/tools/toolchain-probe") {
		return releaseControlBuild{built: true, valid: binding == 1 &&
			yamlMappingKeys(step, []string{pythonPublicName, "uses"})}
	}
	return releaseControlBuild{built: built, valid: true}
}

//nolint:revive // The build flag is observed workflow state, not a choice of behavior.
func releaseControlVerifierCount(script, scriptName, job string, built bool, binding int) (int, bool) {
	count := strings.Count(script, `"$GITHUB_WORKSPACE/.release-control/scripts/`+scriptName+`"`)
	if job == nugetJobName || job == releaseVerifyJob {
		count = strings.Count(script, nativeProbeInvocation+" "+registryCommand)
		if count != 0 && !built {
			return count, false
		}
	}
	return count, count == 0 || binding == 1
}

func validReleaseControlOrder(order releaseControlOrder) bool {
	return order.source == 1 && order.sourceBinding == 1 && order.control == 1 && order.binding == 1
}

func (order *releaseControlOrder) acceptStep(step *yaml.Node, sourceID string) bool {
	if step.Kind != yaml.MappingNode {
		return false
	}
	action := yamlField(step, "uses")
	if action != nil && strings.HasPrefix(action.Value, "actions/checkout@") && !order.acceptCheckout(step) {
		return false
	}
	if yamlScalar(yamlField(step, "id"), yamlStringTag, sourceID) && !order.acceptSourceBinding(step) {
		return false
	}
	return yamlField(step, "env", "RELEASE_CONTROL_SHA") == nil || order.acceptControlBinding(step, sourceID)
}

func (order *releaseControlOrder) acceptSourceBinding(step *yaml.Node) bool {
	if order.source != 1 || order.control != 0 || !validReleaseSourceBinding(step) {
		return false
	}
	order.sourceBinding++
	return true
}

func (order *releaseControlOrder) acceptControlBinding(step *yaml.Node, sourceID string) bool {
	if order.control != 1 || !validReleaseControlBinding(step, sourceID) {
		return false
	}
	order.binding++
	return true
}

func (order *releaseControlOrder) acceptCheckout(step *yaml.Node) bool {
	if order.source == 0 && validReconciliationCheckout(step, map[string]string{workflowRefKey: workflowInputRef}) {
		order.source++
		return true
	}
	if order.sourceBinding == 1 && order.control == 0 && validReconciliationCheckout(step, map[string]string{
		workflowRefKey: workflowControlRef, workflowRepositoryKey: workflowRepository, "path": ".release-control",
	}, "sparse-checkout", "sparse-checkout-cone-mode") {
		order.control++
		return true
	}
	return false
}

func validReleaseSourceBinding(step *yaml.Node) bool {
	script := yamlField(step, "run")
	return yamlMappingKeys(step, []string{pythonPublicName, "id", "shell", "env", "run"}) &&
		script != nil && script.Kind == yaml.ScalarNode && script.Tag == yamlStringTag &&
		strings.Contains(script.Value, `git -C "$GITHUB_WORKSPACE" rev-parse --verify 'HEAD^{commit}'`)
}

func validReleaseControlBinding(step *yaml.Node, sourceID string) bool {
	if !yamlMappingKeys(step, []string{pythonPublicName, "shell", "env", "run"}) ||
		!yamlScalar(yamlField(step, "env", "RELEASE_CONTROL_SHA"), yamlStringTag, workflowControlRef) ||
		!yamlScalar(yamlField(step, "env", "RELEASE_SOURCE_SHA"), yamlStringTag,
			"${{ steps."+sourceID+".outputs.sha }}") {
		return false
	}
	script := yamlField(step, "run")
	return script != nil && script.Kind == yaml.ScalarNode && script.Tag == yamlStringTag &&
		validMetadataText([]byte(script.Value), []string{
			`git -C "$GITHUB_WORKSPACE" rev-parse --verify 'HEAD^{commit}'`,
			`git -C "$control_root" rev-parse --verify 'HEAD^{commit}'`,
			`"$actual_source_sha" != "$RELEASE_SOURCE_SHA"`,
			`"$actual_control_sha" != "$RELEASE_CONTROL_SHA"`,
		})
}
