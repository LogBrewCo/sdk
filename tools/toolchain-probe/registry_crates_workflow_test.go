package main

import "testing"

func TestNativeCratesRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", registryCratesFamily, "steps")
	checked, built, verified := false, false, false
	condition := "${{ ! inputs.dry_run && inputs.include_crates_publish }}"
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check out protected crates registry verifier") {
			checked = validReconciliationCheckout(step, map[string]string{
				workflowRepositoryKey: workflowRepository,
				workflowRefKey:        workflowControlRef, pythonPAXPath: registryControlDirectory,
			}, "sparse-checkout", "sparse-checkout-cone-mode")
		}
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./.release-control/tools/toolchain-probe") {
			built = checked && yamlScalar(yamlField(step, "if"), yamlStringTag, condition)
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Verify public crates.io package") {
			verified = built && yamlScalar(yamlField(step, "if"), yamlStringTag, condition) &&
				yamlScalar(yamlField(step, "run"), yamlStringTag,
					nativeProbeInvocation+` registry-publication --target crates --version `+
						`"${{ steps.crate-version.outputs.version }}"`)
		}
	}
	if !verified {
		t.Fatal("crates readback must follow protected native bootstrap and retain publish condition")
	}
}
