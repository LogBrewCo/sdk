package main

import (
	"strings"
	"testing"
)

func TestBrandNativeCICaller(t *testing.T) {
	t.Parallel()
	source := repositorySource(t, ciWorkflowPath)
	if strings.Contains(source, "check_brand_assets.py") || strings.Contains(source, "generate_brand_assets.py") {
		t.Fatal("CI still invokes Python brand verification")
	}
	steps := yamlField(parseMetadataYAML([]byte(source)), "jobs", "contract-checks", "steps")
	built, checked := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./tools/toolchain-probe") {
			built = yamlField(step, "if") == nil
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check canonical brand assets") {
			run := yamlField(step, "run")
			checked = built && yamlField(step, "if") == nil && run != nil &&
				run.Value == nativeProbeInvocation+` brand-assets "$PWD"`+"\n"+
					nativeProbeInvocation+` brand-generated "$PWD"`+"\n"
		}
	}
	if !checked {
		t.Fatal("brand verification lost unconditional native bootstrap or invocation")
	}
}
