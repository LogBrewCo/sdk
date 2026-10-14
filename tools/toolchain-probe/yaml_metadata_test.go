package main

import (
	"strings"
	"testing"
)

func TestMetadataYAMLDocuments(t *testing.T) {
	t.Parallel()
	for _, path := range []string{
		".github/workflows/reconcile-public-packages.yml", publicationWorkflow, publishWorkflowPath,
	} {
		document := parseMetadataYAML([]byte(repositorySource(t, path)))
		if document == nil || yamlField(document, "on") == nil || yamlField(document, "jobs") == nil {
			t.Fatal("actual workflow structure unavailable")
		}
	}
	for _, input := range []string{
		"", "# empty\n", "[a, b]", "a: 1\na: 2\n", "a: {b: 1, b: 2}",
		"true: value", "1: value", "? [a, b]\n: value", "a: &same value\nb: *same",
		"a: !custom value", "a: !!binary Zm9v", "a: {<<: {b: value}}", "a: *missing",
		"a: value\n---\nb: value", "a: value\n---", "a: value\n...\ntrailing",
		"a: \xff", "a: [", strings.Repeat("#", pythonManifestLimit+1),
		"a: " + strings.Repeat("[", metadataYAMLDepth+1) + "0" + strings.Repeat("]", metadataYAMLDepth+1),
		"a: [" + strings.Repeat("0,", metadataYAMLNodes) + "0]",
	} {
		if parseMetadataYAML([]byte(input)) != nil {
			t.Fatal("ambiguous, unsupported, malformed, or excessive YAML accepted")
		}
	}
}

func TestMetadataYAMLScalars(t *testing.T) {
	t.Parallel()
	document := parseMetadataYAML([]byte("on: {workflow_dispatch: {}}\ntext: 'false'\nflag: false\n"))
	if !yamlScalar(yamlField(document, "text"), "!!str", "false") ||
		!yamlScalar(yamlField(document, "flag"), "!!bool", "false") ||
		yamlScalar(yamlField(document, "text"), "!!bool", "false") ||
		yamlField(document, "missing", "child") != nil || yamlField(document, "text", "child") != nil {
		t.Fatal("YAML scalar type or field traversal changed")
	}
	if parseMetadataYAML([]byte("key: |\n  arbitrary: [content]\n  # literal\n")) == nil {
		t.Fatal("literal shell text rejected as YAML structure")
	}
}
