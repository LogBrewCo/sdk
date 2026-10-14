package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkdownContainedSymlink(t *testing.T) {
	t.Parallel()
	for _, absolute := range []bool{false, true} {
		root := openMarkdownFixture(t, map[string]string{
			policyRootGuide: "[linked](alias.md#linked)", "guide.md": "# Linked",
		})
		target := "guide.md"
		if absolute {
			target = filepath.Join(root.Name(), target)
		}
		if err := os.Symlink(target, filepath.Join(root.Name(), "alias.md")); err != nil {
			t.Fatal(err)
		}
		if !checkMarkdownLinks(root) {
			t.Fatal("contained Markdown symlink rejected")
		}
	}
}

func TestMarkdownSymlinkCycle(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{policyRootGuide: "# Guide"})
	if err := os.Symlink("cycle.md", filepath.Join(root.Name(), "cycle.md")); err != nil {
		t.Fatal(err)
	}
	if checkMarkdownLinks(root) {
		t.Fatal("Markdown symlink cycle accepted")
	}
}
