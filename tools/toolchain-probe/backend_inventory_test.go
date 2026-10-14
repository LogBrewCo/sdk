package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBackendReportInventory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{
		backendReportDirectory + "/example.md":        backendReportFixture,
		backendReportDirectory + "/nested/ignored.md": "ignored nested report",
	})
	result := backendReports(root, markdownFileLimit, markdownByteLimit)
	if !result.complete || len(result.failures) != 0 {
		t.Fatalf("valid report inventory = %+v", result)
	}
	if backendReports(root, 1, markdownByteLimit).complete || backendReports(root, markdownFileLimit, 1).complete {
		t.Fatal("bounded report inventory claimed completion")
	}
}

func TestBackendReportInventoryNonregularAndEscaping(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{backendReportDirectory + "/placeholder.txt": "placeholder"})
	name := filepath.Join(root.Name(), backendReportDirectory, "linked.md")
	if err := os.Symlink(filepath.Join(t.TempDir(), "outside.md"), name); err != nil {
		t.Fatal(err)
	}
	if backendReports(root, markdownFileLimit, markdownByteLimit).complete {
		t.Fatal("escaping report read claimed completion")
	}
	if err := os.Remove(name); err != nil {
		t.Fatal(err)
	}
	const reportDirectoryMode = 0o700
	if err := os.Mkdir(name, reportDirectoryMode); err != nil {
		t.Fatal(err)
	}
	if backendReports(root, markdownFileLimit, markdownByteLimit).complete {
		t.Fatal("directory report read claimed completion")
	}
}

func TestBackendReportInventoryFailure(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{backendReportDirectory + "/invalid.md": "# Invalid"})
	result := backendReports(root, markdownFileLimit, markdownByteLimit)
	if !result.complete || len(result.failures) == 0 || result.failures[0].reason != "invalid-title" {
		t.Fatalf("invalid report inventory = %+v", result)
	}
	empty := openMarkdownFixture(t, map[string]string{})
	if backendReports(empty, markdownFileLimit, markdownByteLimit).complete {
		t.Fatal("missing report inventory claimed completion")
	}
}
