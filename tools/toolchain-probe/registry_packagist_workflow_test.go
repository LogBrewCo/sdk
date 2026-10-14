package main

import "testing"

const registryControlDirectory = ".release-control"

func TestNativePackagistRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", registryPackagistFamily, "steps")
	checked, built, verified := false, false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check out protected Packagist registry verifier") {
			checked = validReconciliationCheckout(step, map[string]string{
				workflowRepositoryKey: workflowRepository,
				workflowRefKey:        workflowControlRef, pythonPAXPath: registryControlDirectory,
			}, "sparse-checkout", "sparse-checkout-cone-mode")
		}
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = checked
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Verify public Packagist package") {
			verified = built && yamlScalar(yamlField(step, "run"), yamlStringTag,
				nativeProbeInvocation+" registry-publication --target packagist --retries 20 --retry-delay 30")
		}
	}
	if !verified {
		t.Fatal("Packagist registry readback must follow protected native bootstrap")
	}
}
