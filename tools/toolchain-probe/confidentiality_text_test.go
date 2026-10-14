package main

import (
	"slices"
	"strings"
	"testing"
)

const confidentialityRemoteTerm = "ss" + "h"

func TestConfidentialityTerms(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ line, terms string }{
		{"public integration", ""},
		{confidentialityFixtureTerm, confidentialityFixtureTerm},
		{"ProcessHandle.current()", ""},
		{confidentialityRemoteTerm + "_private_key=fixture", confidentialityRemoteTerm},
		{"1" + confidentialityRemoteTerm + " " + confidentialityRemoteTerm + "2", ""},
		{"_" + confidentialityRemoteTerm + "_ /S" + "SH", confidentialityRemoteTerm},
		{"sec" + "ret TO" + "KEN sec" + "ret", "sec" + "ret|to" + "ken"},
		{"host" + "names host" + "name", "host" + "name|host" + "names"},
		{"back" + "up clean" + "up", "back" + "up|clean" + "up"},
		{"δ" + confidentialityRemoteTerm + "π", confidentialityRemoteTerm},
	} {
		if actual := confidentialityTerms(test.line); actual != test.terms {
			t.Fatalf("terms for %q = %q, want %q", test.line, actual, test.terms)
		}
	}
}

func TestConfidentialityREADMEWords(t *testing.T) {
	t.Parallel()
	for _, word := range []string{
		"real-user", "real_user", "real user", "smoke", "proof", "prove", "verify",
		"verified", "verifier", "verification", "test", "tests", "testing", "temporary app",
		"temp app", "disposable app", "fresh app", "fresh temporary app", "package check",
		"repository checks", "artifact inspection", "ci run", "registry mechanics",
		"automation agent", "for automation agents", "agent-facing",
	} {
		if !confidentialityREADMEForbidden("Use "+word+" here.") ||
			!confidentialityREADMEForbidden(strings.ToUpper(word)) {
			t.Fatalf("README term escaped: %q", word)
		}
	}
	for _, line := range []string{
		"latest events", "contest results", "testament", "proofα", "αproof", "_test", "verİfyα", "verıfyα",
	} {
		if confidentialityREADMEForbidden(line) {
			t.Fatalf("README whole-word boundary changed: %q", line)
		}
	}
}

func TestConfidentialityGuidePaths(t *testing.T) {
	t.Parallel()
	for _, name := range []string{confidentialityGuide, confidentialityPackageGuide, confidentialityNestedGuide} {
		for _, home := range []string{
			"/Users/example/work/sdk", "/home/example/work/sdk", `C:\Users\example\work\sdk`,
		} {
			if !confidentialityHomePath(name, "Read "+home+".") {
				t.Fatalf("guide path was not rejected: %q", name)
			}
			if confidentialityHomePath("CONTRIBUTING.md", home) {
				t.Fatal("home-path policy expanded outside agent guides")
			}
		}
	}
	for _, line := range []string{
		"/Users//project", "/home/user", "/Users/ /project", `C:\Users\\project`,
		"/Users/\u00a0/project", "/home/\u0085/project", "/Users/\v/project",
	} {
		if confidentialityHomePath(confidentialityGuide, line) {
			t.Fatalf("non-home path matched: %q", line)
		}
	}
}

func TestConfidentialityLineBoundaries(t *testing.T) {
	t.Parallel()
	for _, separator := range []string{
		"\n", "\r\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\u0085", "\u2028", "\u2029",
	} {
		actual := confidentialityLines("first" + separator + separator + "third" + separator)
		if !slices.Equal(actual, []string{"first", "", "third"}) {
			t.Fatalf("line numbering changed for %q: %q", separator, actual)
		}
	}
	if lines := confidentialityLines(""); len(lines) != 0 {
		t.Fatalf("empty text has lines: %q", lines)
	}
}
