package main

import "testing"

func TestMarkdownInvalidPercentUTF8(t *testing.T) {
	t.Parallel()
	for input, want := range map[string]string{
		"%FF%FF": "\uFFFD\uFFFD", "%E2%82": "\uFFFD", "%E2%28%A1": "\uFFFD(\uFFFD",
		"%ED%A0%80": "\uFFFD\uFFFD\uFFFD", "%F0%9F%92": "\uFFFD",
		"%C0%AF": "\uFFFD\uFFFD", "%F4%90%80%80": "\uFFFD\uFFFD\uFFFD\uFFFD",
		"%C3%BC%xx+": "ü%xx+",
	} {
		if got := markdownUnquote(input); got != want {
			t.Fatalf("decoded %q = %q, want %q", input, got, want)
		}
	}
}
