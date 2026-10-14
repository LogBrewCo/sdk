package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkdownLocalFiles(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		links string
		valid bool
	}{
		{`[docs](docs) [guide](docs/guide.md) [install](docs/guide.md#install-sdk)`, true},
		{`[self](#start) [duplicate](docs/guide.md#install-sdk-1)`, true},
		{`[encoded](docs/guide.md#install%2Dsdk)`, true},
		{`[missing](docs/missing.md)`, false},
		{`[missing anchor](docs/guide.md#not-here)`, false},
		{`[escape](../outside.md)`, false},
		{`[absolute](/etc/hosts)`, false},
	} {
		root := openMarkdownFixture(t, map[string]string{
			policyRootGuide:           "# Start\n" + test.links,
			"docs/guide.md":           "# Quick Start\n## Install SDK\n## Install SDK\n",
			"node_modules/ignored.md": "[missing](absent.md)",
		})
		if checkMarkdownLinks(root) != test.valid {
			t.Fatalf("local links accepted = %t, want %t", !test.valid, test.valid)
		}
	}
}

func openMarkdownFixture(t *testing.T, files map[string]string) *os.Root {
	t.Helper()
	directory := confidentialityFixture(t, files)
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeError := root.Close(); closeError != nil {
			t.Error(closeError)
		}
	})
	return root
}

func TestMarkdownUnreadableAndEscape(t *testing.T) {
	t.Parallel()
	if checkMarkdownLinks(openMarkdownFixture(t, map[string]string{"text.txt": "no documents"})) {
		t.Fatal("empty Markdown inventory accepted")
	}
	if checkMarkdownLinks(openMarkdownFixture(t, map[string]string{policyRootGuide: "\xff"})) {
		t.Fatal("invalid UTF-8 document accepted")
	}
	root := openMarkdownFixture(t, map[string]string{policyRootGuide: "[escape](outside.md)"})
	outside := filepath.Join(t.TempDir(), "outside.md")
	if err := os.WriteFile(outside, []byte("# Outside"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root.Name(), "outside.md")); err != nil {
		t.Fatal(err)
	}
	if checkMarkdownLinks(root) {
		t.Fatal("external symlink accepted")
	}
}
