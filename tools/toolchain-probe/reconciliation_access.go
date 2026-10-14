package main

import (
	"os"
	"slices"
	"strings"

	"go.yaml.in/yaml/v3"
)

const (
	reconciliationAccessFamily = "reconciliation-access"
	reconciliationWorkflowPath = ".github/workflows/reconcile-public-packages.yml"
	workflowCheckoutAction     = "actions/checkout@v6"
	workflowInputRef           = "${{ inputs.ref }}"
	workflowControlRef         = "${{ github.workflow_sha }}"
	workflowRepository         = "${{ github.repository }}"
	workflowOIDCWrite          = "id-token: write"
	reconciliationJobCount     = 2
)

// This check covers declarations and required verification seams, not their execution or artifact provenance.
func checkReconciliationAccess(root *os.Root) bool {
	data, read := readReleaseMetadata(root, reconciliationWorkflowPath)
	return read && validReconciliationAccess(data)
}

func validReconciliationAccess(data []byte) bool {
	if !validMetadataText(data, []string{
		`[[ "$CONTROL_REF" != "refs/heads/main"`, nativeProbeInvocation + " publication-run",
		"python-archive resolve-public", "uses: ./.release-control/tools/toolchain-probe",
		"python-archive create-manifest", nativeProbeInvocation + " nuget-public",
		`--source-root "$GITHUB_WORKSPACE"`, nativeProbeInvocation + " python-public-consumer",
		"real_user_dotnet_selected_public_nuget_smoke.sh",
	}) {
		return false
	}
	for _, forbidden := range []string{
		workflowOIDCWrite, "environment: release", "gh-action-pypi-publish", "dotnet nuget push", "nuget/login",
	} {
		if strings.Contains(string(data), forbidden) {
			return false
		}
	}
	document := parseMetadataYAML(data)
	permissions := yamlField(document, "permissions")
	triggers := yamlField(document, "on")
	jobs := yamlField(document, "jobs")
	if !yamlMappingSize(permissions, reconciliationJobCount) || !yamlMappingSize(triggers, 1) ||
		!yamlMappingSize(jobs, reconciliationJobCount) ||
		!yamlScalar(yamlField(permissions, "actions"), yamlStringTag, "read") ||
		!yamlScalar(yamlField(permissions, "contents"), yamlStringTag, "read") ||
		yamlField(triggers, "workflow_dispatch", "inputs") == nil {
		return false
	}
	return validReconciliationJob(yamlField(jobs, "pypi")) && validReconciliationJob(yamlField(jobs, "nuget")) &&
		publicationWorkflowNative(data, registryPythonFamily) && publicationWorkflowNative(data, nugetJobName)
}

func validReconciliationJob(job *yaml.Node) bool {
	if job == nil || job.Kind != yaml.MappingNode || yamlField(job, "permissions") != nil ||
		yamlField(job, "environment") != nil || yamlField(job, "uses") != nil {
		return false
	}
	return validReconciliationSteps(yamlField(job, "steps"))
}

func validReconciliationSteps(steps *yaml.Node) bool {
	if steps == nil || steps.Kind != yaml.SequenceNode || len(steps.Content) < 4 ||
		!validReconciliationCheckout(steps.Content[0], map[string]string{workflowRefKey: workflowInputRef}) ||
		!validReconciliationCheckout(steps.Content[2], map[string]string{
			workflowRefKey: workflowControlRef, workflowRepositoryKey: workflowRepository, "path": ".release-control",
		}, "sparse-checkout", "sparse-checkout-cone-mode") {
		return false
	}
	for index, step := range steps.Content {
		if step.Kind != yaml.MappingNode {
			return false
		}
		action := yamlField(step, "uses")
		if action != nil && strings.HasPrefix(action.Value, "actions/checkout@") && index != 0 && index != 2 {
			return false
		}
	}
	return true
}

func validReconciliationCheckout(step *yaml.Node, expected map[string]string, extra ...string) bool {
	if !yamlMappingKeys(step, []string{pythonPublicName, "uses", "with"}) ||
		!yamlScalar(yamlField(step, "uses"), yamlStringTag, workflowCheckoutAction) {
		return false
	}
	inputs := yamlField(step, "with")
	if !yamlScalar(yamlField(inputs, "persist-credentials"), yamlBooleanTag, "false") {
		return false
	}
	allowed := append([]string{"persist-credentials"}, extra...)
	for key, value := range expected {
		if !yamlScalar(yamlField(inputs, key), yamlStringTag, value) {
			return false
		}
		allowed = append(allowed, key)
	}
	return yamlMappingKeys(inputs, allowed)
}

func checkoutPersistence(step *yaml.Node) *yaml.Node {
	return yamlField(step, "with", "persist-credentials")
}

func yamlMappingSize(node *yaml.Node, size int) bool {
	return node != nil && node.Kind == yaml.MappingNode && len(node.Content) == size*2
}

func yamlMappingKeys(node *yaml.Node, allowed []string) bool {
	if node == nil || node.Kind != yaml.MappingNode {
		return false
	}
	for index := 0; index < len(node.Content); index += 2 {
		if !slices.Contains(allowed, node.Content[index].Value) {
			return false
		}
	}
	return true
}
