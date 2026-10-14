package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCIStaticWorkflowInventory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{
		ciWorkflowDirectory + "/ci.yml": "jobs:\r\n\r\nrun: bash scripts/check_shell_static.sh" +
			"\u2028run: go test ./...",
		ciWorkflowDirectory + "/release.yaml":       "run: bash scripts/check_js_package.sh",
		ciWorkflowDirectory + "/nested/ignored.yml": "run: shellcheck file.sh",
	})
	result := ciStaticWorkflowInventory(root, markdownFileLimit, markdownByteLimit)
	if !result.complete || len(result.findings) != 1 || result.findings[0].Line != 3 ||
		result.findings[0].Source != ciWorkflowDirectory+"/ci.yml" {
		t.Fatalf("CI static inventory = %+v", result)
	}
	if ciStaticWorkflowInventory(root, 1, markdownByteLimit).complete ||
		ciStaticWorkflowInventory(root, markdownFileLimit, 1).complete {
		t.Fatal("limited CI workflow scan claimed completion")
	}
}

func TestCIStaticWorkflowUnreadableInputs(t *testing.T) {
	t.Parallel()
	for _, content := range []string{"\xff", ""} {
		root := openMarkdownFixture(t, map[string]string{ciWorkflowDirectory + "/invalid.yml": content})
		if content == "" {
			name := filepath.Join(root.Name(), ciWorkflowDirectory, "invalid.yml")
			if err := os.Remove(name); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(t.TempDir(), "outside.yml"), name); err != nil {
				t.Fatal(err)
			}
		}
		if ciStaticWorkflowInventory(root, markdownFileLimit, markdownByteLimit).complete {
			t.Fatal("invalid UTF8 or escaping workflow read claimed completion")
		}
	}
}

func TestCIStaticWorkflowMissingInventory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{})
	if ciStaticWorkflowInventory(root, markdownFileLimit, markdownByteLimit).complete {
		t.Fatal("missing CI workflow inventory claimed completion")
	}
}
