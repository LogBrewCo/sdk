package main

import "testing"

func TestJSSyntaxWorkflowCaller(t *testing.T) {
	t.Parallel()
	steps := yamlField(parseMetadataYAML([]byte(repositorySource(t, ciWorkflowPath))),
		"jobs", "contract-checks", "steps")
	if steps == nil {
		t.Fatal("CI contract steps unavailable")
	}
	built, checked := false, false
	for _, step := range steps.Content {
		if yamlScalar(yamlField(step, "uses"), yamlStringTag, "./tools/toolchain-probe") {
			built = yamlField(step, "if") == nil
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Check JavaScript source syntax") {
			checked = built && yamlScalar(yamlField(step, "if"), yamlStringTag,
				"${{ needs.changed-areas.outputs.javascript == 'true' }}") &&
				yamlScalar(yamlField(step, "run"), yamlStringTag, nativeProbeInvocation+` js-syntax "$PWD"`)
		}
		if yamlScalar(yamlField(step, "name"), yamlStringTag, "Run JavaScript SDK tests") && !checked {
			t.Fatal("JavaScript tests precede native syntax verification")
		}
	}
	if !checked {
		t.Fatal("CI lost native syntax bootstrap, selection, or invocation")
	}
}

func TestJSSyntaxNativeChangeSelection(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"js_syntax.go", "js_native_archive.go", "js_syntax.json"} {
		areas := classifyAreas([]string{"tools/toolchain-probe/" + name})
		if !areas[areaJS] || !areas[areaGo] || !areas[areaPython] {
			t.Fatal("native JavaScript change omitted an affected consumer")
		}
	}
}
