package main

import (
	"reflect"
	"testing"
)

const markdownQuickStart = "quick-start"

func TestMarkdownAnchors(t *testing.T) {
	t.Parallel()
	for text, want := range map[string]string{
		"Quick Start": markdownQuickStart, "<b>Install</b> `SDK`!": "install-sdk",
		"Türkçe İleti ²": "türkçe-ileti-²", "one_two - three": "one_two---three",
		"a\u00a0b\x1fc": "a-b-c", "punctuation?!": "punctuation",
		"e\u0301": "e", "!!!": "",
	} {
		if got := markdownAnchor(text); got != want {
			t.Fatalf("anchor = %q, want %q", got, want)
		}
	}
	anchors := markdownAnchors("# Quick Start\n## Quick Start\r### Quick Start ###\n" +
		"####### Invalid\n # Indented\n#No space\n## !!!\n")
	if !reflect.DeepEqual(anchors, map[string]bool{
		markdownQuickStart: true, "quick-start-1": true, "quick-start-2": true,
	}) {
		t.Fatalf("heading anchors = %v", anchors)
	}
	if markdownHeading("##\u00a0Native Heading ###") != "Native Heading" {
		t.Fatal("Unicode heading whitespace rejected")
	}
}

func TestMarkdownTargets(t *testing.T) {
	t.Parallel()
	targets := markdownLocalTargets(`[guide](docs/guide.md#install-sdk "title") ` +
		`![image](missing.png) [web](HTTPS://example.com) [email](mailto:test@example.com) ` +
		`[local](a%20b.md#hello%20world) [self](#quick-start) [bad](bad%xx.md) [plus](a+b.md)`)
	want := []markdownTarget{
		{path: "docs/guide.md", anchor: "install-sdk"},
		{path: "a b.md", anchor: "hello world"},
		{path: "", anchor: markdownQuickStart},
		{path: "bad%xx.md", anchor: ""},
		{path: "a+b.md", anchor: ""},
	}
	if !reflect.DeepEqual(targets, want) {
		t.Fatalf("targets = %v, want %v", targets, want)
	}
	if markdownUnquote("%C3%BC") != "ü" || markdownUnquote("%FF") != "\uFFFD" {
		t.Fatal("UTF-8 target decoding changed")
	}
	if len(markdownLocalTargets("[invalid](two\u00a0words.md)")) != 0 ||
		len(markdownLocalTargets("[valid](guide.md\u00a0\"title\")")) != 1 {
		t.Fatal("Unicode link whitespace parsing changed")
	}
}
