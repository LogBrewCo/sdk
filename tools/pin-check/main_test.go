package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const workflow = `on: push
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: npm ci
      - run: npm install left-pad
`

func repository(t *testing.T, allowlist string) string {
	t.Helper()
	root := t.TempDir()
	write := func(name, text string) {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(".github/workflows/test.yml", workflow)
	if allowlist != "" {
		write(allowlistPath, allowlist)
	}
	return root
}

func TestRun(t *testing.T) {
	const row = ".github/workflows/test.yml\tnpm install left-pad\treason\n"
	cases := []struct {
		name      string
		allowlist string
		code      int
		output    string
	}{
		{"unlisted install fails", "", 1, "npm install left-pad"},
		{"listed install passes", "# comment\n" + row, 0, "1 installs pinned, 1 listed"},
		{"stale row fails", row + ".github/workflows/test.yml\tnpm install gone\treason\n", 1, "remove the row"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code, err := run(repository(t, c.allowlist), &stdout, &stderr)
			if err != nil {
				t.Fatal(err)
			}
			if code != c.code {
				t.Fatalf("code = %d, want %d; stderr: %s", code, c.code, stderr.String())
			}
			if output := stdout.String() + stderr.String(); !strings.Contains(output, c.output) {
				t.Fatalf("output %q does not contain %q", output, c.output)
			}
		})
	}
}

func TestRunSkipsInstalledPackages(t *testing.T) {
	root := repository(t, ".github/workflows/test.yml\tnpm install left-pad\treason\n")
	path := filepath.Join(root, "apps/n8n/node_modules/cpu-features/Dockerfile")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("FROM ubuntu:latest\nRUN npm install left-pad\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code, err := run(root, &stdout, &stderr)
	if err != nil {
		t.Fatal(err)
	}
	if code != 0 || !strings.Contains(stdout.String(), "1 installs pinned, 1 listed") {
		t.Fatalf("code = %d, output %q; stderr: %s", code, stdout.String(), stderr.String())
	}
}

func TestReadAllowlistRejectsBadRows(t *testing.T) {
	for _, text := range []string{"path\tcommand\n", "path\tcommand\t \n", "a\tb\tc\na\tb\tc\n"} {
		path := filepath.Join(t.TempDir(), "list.tsv")
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readAllowlist(path); err == nil {
			t.Errorf("readAllowlist(%q) succeeded, want an error", text)
		}
	}
}

func TestNormalize(t *testing.T) {
	if got := normalize("npm  install \\\n   left-pad"); got != "npm install left-pad" {
		t.Errorf("normalize = %q", got)
	}
}
