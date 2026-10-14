package main

import "testing"

func publicationArgumentsFixture() []string {
	identity := publicationHTTPIdentity()
	return []string{
		"--repository", identity.repository, "--run-id", "42", "--family", identity.family,
		"--workflow-sha", identity.workflowSHA, "--source-sha", identity.sourceSHA,
	}
}

func TestPublicationOptions(t *testing.T) {
	t.Parallel()
	arguments := publicationArgumentsFixture()
	identity := publicationOptions(arguments)
	if identity == nil || *identity != publicationHTTPIdentity() {
		t.Fatal("valid publication options rejected or changed")
	}
	for index := 0; index < len(arguments); index += 2 {
		missing := append(append([]string{}, arguments[:index]...), arguments[index+2:]...)
		if publicationOptions(missing) != nil {
			t.Fatal("missing required publication option accepted")
		}
	}
	for _, extra := range [][]string{{"--unknown-option", "unused-option-value"}, {"trailing-argument"}, {"--family"}} {
		if publicationOptions(append(publicationArgumentsFixture(), extra...)) != nil {
			t.Fatal("invalid publication argument accepted")
		}
	}
}
