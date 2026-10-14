package main

import (
	"strings"
	"testing"
)

func TestNativeMavenRegistryCaller(t *testing.T) {
	t.Parallel()
	workflow := repositorySource(t, publicationWorkflow)
	job := workflowJob(t, workflow, mavenMetadataFamily)
	requireOrderedSource(t, job, "Check out protected Maven release control",
		"Build protected Maven registry verifier", "Check selected Maven version collisions",
		"Verify Maven Central publication")
	if strings.Count(job, nativeProbeInvocation+" "+registryCommand) != 3 ||
		strings.Contains(job, "python3 scripts/check_registry_publication.py") {
		t.Fatal("Maven collision, dependency and publication checks must use native verifier")
	}
	steps := yamlField(parseMetadataYAML([]byte(workflow)), "jobs", mavenMetadataFamily, "steps")
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check out protected Maven release control") &&
			!validReconciliationCheckout(step, map[string]string{
				workflowRepositoryKey: workflowRepository,
				workflowRefKey:        workflowControlRef, pythonPAXPath: registryControlDirectory,
			}, "sparse-checkout", "sparse-checkout-cone-mode") {
			t.Fatal("Maven native verifier checkout is not protected")
		}
	}
}
