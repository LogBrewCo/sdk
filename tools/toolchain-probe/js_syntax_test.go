package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	jsSyntaxFixtureMode       = 0o600
	jsSyntaxFixtureWhitespace = " "
)

func TestJSSyntaxInventory(t *testing.T) {
	t.Parallel()
	root := openMarkdownFixture(t, map[string]string{
		"js/example/index.js":       "export const value = 1;",
		"js/example/dist/broken.js": "export const = ;",
		"js/example/notes.txt":      "syntax inventory fixture",
	})
	names, valid := jsSyntaxFiles(root)
	if !valid || len(names) != 1 || names[0] != "js/example/index.js" {
		t.Fatal("syntax source selection changed")
	}
	link := filepath.Join(root.Name(), "js", "link.js")
	if err := os.Symlink(filepath.Join(t.TempDir(), "missing.js"), link); err != nil {
		t.Fatal("linked syntax source fixture unavailable")
	}
	if _, valid := jsSyntaxFiles(root); valid {
		t.Fatal("linked syntax source accepted")
	}
}

func TestJSSyntaxNativeParser(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_OXLINT") != "1" {
		t.Skip("syntax integration requires native parser enablement")
	}
	for _, fixture := range []struct {
		name, source string
		result       int
	}{
		{name: "valid-module", source: "export const syntaxFixture = 1;", result: exitOK},
		{name: "invalid-module", source: "export const = ;", result: exitFailure},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			t.Parallel()
			root := openMarkdownFixture(t, map[string]string{
				"js/example/source.js":                 fixture.source,
				"tools/toolchain-probe/js_syntax.json": repositorySource(t, "tools/toolchain-probe/js_syntax.json"),
			})
			if runJSSyntax([]string{root.Name()}, io.Discard, io.Discard) != fixture.result {
				t.Fatal("native parser result changed")
			}
		})
	}
}

func TestJSSyntaxRejectsMissingSources(t *testing.T) {
	t.Parallel()
	if runJSSyntax(nil, io.Discard, io.Discard) != exitUsage ||
		runJSSyntax([]string{t.TempDir()}, io.Discard, io.Discard) != exitFailure {
		t.Fatal("invalid syntax check accepted")
	}
}

func TestJSSyntaxRepository(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_OXLINT") != "1" {
		t.Skip("repository syntax integration requires native parser enablement")
	}
	directory, err := filepath.Abs("../..")
	if err != nil || runJSSyntax([]string{directory}, io.Discard, io.Discard) != exitOK {
		t.Fatal("repository native syntax check failed")
	}
}

func TestJSSyntaxSourceByteLimit(t *testing.T) {
	t.Parallel()
	const sourceName = "js/example/limit.js"
	root := openMarkdownFixture(t, map[string]string{
		sourceName: strings.Repeat(jsSyntaxFixtureWhitespace, brandSVGByteLimit),
	})
	names, valid := jsSyntaxFiles(root)
	if !valid || len(names) != 1 || names[0] != sourceName {
		t.Fatal("exact syntax source byte limit rejected")
	}
	file, err := root.OpenFile(sourceName, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	_, writeError := file.WriteString(jsSyntaxFixtureWhitespace)
	closeError := file.Close()
	if writeError != nil || closeError != nil {
		t.Fatal("oversized syntax fixture unavailable")
	}
	if _, accepted := jsSyntaxFiles(root); accepted {
		t.Fatal("oversized syntax source accepted")
	}
}

func TestJSSyntaxAggregateByteLimit(t *testing.T) {
	t.Parallel()
	const lastSource = "js/example/extra.js"
	files := map[string]string{}
	chunk := strings.Repeat(jsSyntaxFixtureWhitespace, brandSVGByteLimit)
	for index := range markdownByteLimit / brandSVGByteLimit {
		files[fmt.Sprintf("js/example/%d.js", index)] = chunk
	}
	root := openMarkdownFixture(t, files)
	names, valid := jsSyntaxFiles(root)
	if !valid || len(names) != len(files) {
		t.Fatal("exact aggregate syntax byte limit rejected")
	}
	if err := root.WriteFile(lastSource, []byte(jsSyntaxFixtureWhitespace), jsSyntaxFixtureMode); err != nil {
		t.Fatal(err)
	}
	if _, accepted := jsSyntaxFiles(root); accepted {
		t.Fatal("excess aggregate syntax bytes accepted")
	}
}

func TestJSSyntaxTraversalEntryLimit(t *testing.T) {
	t.Parallel()
	files := map[string]string{"js/source.js": jsSyntaxFixtureWhitespace}
	// The js directory and source file each consume one traversal entry.
	for index := range markdownFileLimit - 2 {
		files[fmt.Sprintf("js/%04d.txt", index)] = ""
	}
	root := openMarkdownFixture(t, files)
	if names, valid := jsSyntaxFiles(root); !valid || len(names) != 1 {
		t.Fatal("exact syntax traversal entry limit rejected")
	}
	if err := root.WriteFile("js/extra.txt", nil, jsSyntaxFixtureMode); err != nil {
		t.Fatal(err)
	}
	if _, accepted := jsSyntaxFiles(root); accepted {
		t.Fatal("ignored extension bypassed traversal entry bound")
	}
}
