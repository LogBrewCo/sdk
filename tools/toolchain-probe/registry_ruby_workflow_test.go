package main

import "testing"

func TestNativeRubyRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", registryRubyFamily, "steps")
	checked, built, verified := false, false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check out protected RubyGems registry verifier") {
			checked = validReconciliationCheckout(step, map[string]string{
				workflowRepositoryKey: workflowRepository,
				workflowRefKey:        workflowControlRef, pythonPAXPath: registryControlDirectory,
			}, "sparse-checkout", "sparse-checkout-cone-mode")
		}
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = checked
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Verify public RubyGems package") {
			verified = built && yamlScalar(yamlField(step, "run"), yamlStringTag,
				nativeProbeInvocation+" registry-publication --target rubygems")
		}
	}
	if !verified {
		t.Fatal("RubyGems readback must follow protected native bootstrap")
	}
}
