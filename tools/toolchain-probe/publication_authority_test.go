package main

import (
	"strings"
	"testing"
)

func TestPublicationIdentityAuthority(t *testing.T) {
	t.Parallel()
	const revisionWidth = 40
	const oversizedRepositoryWidth = 101
	_, valid := publicationRunFixture()
	valid.workflowSHA = strings.Repeat("a", revisionWidth)
	valid.sourceSHA = strings.Repeat("b", revisionWidth)
	if !publicationIdentityValid(valid) {
		t.Fatal("valid publication request rejected")
	}
	for _, repository := range []string{
		"", "owner", "owner/repo/extra", "../repo", "owner/-repo",
		"owner/repo?query", "owner/repo\n", "owner/" + strings.Repeat("x", oversizedRepositoryWidth),
	} {
		invalid := valid
		invalid.repository = repository
		if publicationIdentityValid(invalid) {
			t.Fatalf("invalid publication repository accepted: %q", repository)
		}
	}
	for _, revision := range []string{
		"", githubDefaultBranch, strings.Repeat("A", revisionWidth), strings.Repeat("a", revisionWidth-1),
		strings.Repeat("a", revisionWidth) + "\n",
	} {
		invalid := valid
		invalid.sourceSHA = revision
		if publicationIdentityValid(invalid) {
			t.Fatal("invalid publication source revision accepted")
		}
		invalid = valid
		invalid.workflowSHA = revision
		if publicationIdentityValid(invalid) {
			t.Fatal("invalid publication workflow revision accepted")
		}
	}
	invalid := valid
	invalid.runID = 0
	if publicationIdentityValid(invalid) {
		t.Fatal("nonpositive publication run accepted")
	}
	invalid = valid
	invalid.family = "unsupported-publication-family"
	if publicationIdentityValid(invalid) {
		t.Fatal("unsupported publication family accepted")
	}
}
