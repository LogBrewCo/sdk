package main

import (
	"path/filepath"
	"testing"
)

func TestMarkdownAbsoluteTargetBoundary(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{policyRootGuide: "# Boundary"})
	check := markdownCheck{
		anchors: make(map[string]map[string]bool), root: root,
		failure: markdownFailure{source: "", reason: "", line: 0}, remaining: markdownByteLimit,
	}
	inside := markdownTarget{path: filepath.Join(root.Name(), policyRootGuide), anchor: "boundary"}
	if check.targetReason(policyRootGuide, inside) != "" {
		t.Fatal("absolute target inside repository rejected")
	}
	outside := markdownTarget{path: filepath.Join(root.Name()+"-other", policyRootGuide), anchor: ""}
	if check.targetReason(policyRootGuide, outside) != "target-outside-repository" {
		t.Fatal("absolute target with shared prefix accepted")
	}
}

func TestMarkdownInventoryLimits(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{policyRootGuide: "# Boundary", "second.md": "# Other"})
	const enoughEntries = 4
	if _, valid := markdownFilesWithinLimits(root, 1, enoughEntries); valid {
		t.Fatal("Markdown inventory exceeded file limit")
	}
	if _, valid := markdownFilesWithinLimits(root, markdownFileLimit, 1); valid {
		t.Fatal("Markdown inventory exceeded entry limit")
	}
	if files, valid := markdownFilesWithinLimits(root, markdownFileLimit, enoughEntries); !valid || len(files) != 2 {
		t.Fatal("bounded Markdown inventory rejected valid files")
	}
}
