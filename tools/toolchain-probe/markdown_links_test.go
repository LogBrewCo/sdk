package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeMarkdownTree(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestMarkdownLinksAcceptValidLinks(t *testing.T) {
	t.Parallel()
	root := writeMarkdownTree(t, map[string]string{
		"docs/guide.md": "# Quick Start\n\n## Install `SDK` <sup>new</sup>\n## Setup\n## Setup\n## Café & Más ##\n",
		"README.md": "# Readme\n[docs](docs)\n[guide](docs/guide.md \"Guide\")\n[install](docs/guide.md#install-sdk-new)\n" +
			"[again](docs/guide.md#setup-1)\n[accent](docs/guide.md#café-más)\n[self](#readme)\n" +
			"![image](missing.png)\n[site](https://example.test/x) [mail](MAILTO:dev@example.test)\n" +
			"[escaped](docs%2Fguide.md)\n[outside escape](%zz) <- invalid escape stays literal\n",
		"%zz":                        "",
		"node_modules/pkg/README.md": "[broken](nowhere.md)\n",
	})
	var output, diagnostic bytes.Buffer
	if code := checkMarkdownLinks([]string{root}, &output, &diagnostic); code != exitOK {
		t.Fatalf("code %d: %s", code, diagnostic.String())
	}
	if output.String() != "markdown links ok\n" {
		t.Fatalf("output %q", output.String())
	}
}

func TestMarkdownLinksReportEachFailureClass(t *testing.T) {
	t.Parallel()
	root := writeMarkdownTree(t, map[string]string{
		"docs/guide.md": "# Existing\n",
		"README.md": "[missing](docs/missing.md)\n[anchor](docs/guide.md#not-here)\n" +
			"[outside](../outside.md)\n",
		"bad.md": "\xff\n",
	})
	var output, diagnostic bytes.Buffer
	if code := checkMarkdownLinks([]string{root}, &output, &diagnostic); code != exitFailure {
		t.Fatalf("code %d", code)
	}
	want := []string{
		"README.md:1: missing link target: docs/missing.md",
		"README.md:2: missing heading anchor #not-here in docs/guide.md",
		"README.md:3: link leaves repository: ../outside.md",
		"bad.md: unreadable or not UTF-8",
	}
	if got := strings.Split(strings.TrimSpace(diagnostic.String()), "\n"); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("failures %q", got)
	}
}

func TestMarkdownLinksRejectEmptyOrMissingRoots(t *testing.T) {
	t.Parallel()
	if got := markdownLinkFailures(t.TempDir()); len(got) != 1 || got[0] != "no Markdown files found" {
		t.Fatalf("empty root: %q", got)
	}
	if got := markdownLinkFailures(filepath.Join(t.TempDir(), "absent")); len(got) != 1 || got[0] != "repository root is unavailable" {
		t.Fatalf("missing root: %q", got)
	}
	var output, diagnostic bytes.Buffer
	if code := checkMarkdownLinks(nil, &output, &diagnostic); code != exitUsage {
		t.Fatalf("usage code %d", code)
	}
}
