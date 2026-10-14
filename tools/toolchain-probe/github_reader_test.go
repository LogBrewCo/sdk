package main

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

func TestGitHubReaderFixedGET(t *testing.T) {
	t.Parallel()
	for index, kind := range []string{githubFullEvidence, githubSummaryEvidence, githubEnvironmentRead} {
		request := githubRequestFixture()
		calls := 0
		runner := func(_ context.Context, arguments []string) ([]byte, bool) {
			calls++
			want := []string{"api", "--method", "GET", githubSafetyPaths(request)[index]}
			if !reflect.DeepEqual(arguments, want) {
				t.Fatalf("unexpected GitHub invocation: %v", arguments)
			}
			return []byte(`{"valid":true}`), true
		}
		document, valid := githubSafetyRead(t.Context(), request, kind, runner)
		if !valid || calls != 1 || !githubBoolean(eventObject(document), "valid", true) {
			t.Fatal("fixed GitHub GET read failed")
		}
	}
}

func TestGitHubReaderFailures(t *testing.T) {
	t.Parallel()
	for _, data := range []string{"not-json", `{"a":1,"a":2}`, strings.Repeat("x", pythonManifestLimit+1)} {
		runner := func(context.Context, []string) ([]byte, bool) { return []byte(data), true }
		if _, valid := githubSafetyRead(t.Context(), githubRequestFixture(), githubFullEvidence, runner); valid {
			t.Fatal("invalid GitHub response accepted")
		}
	}
	failed := func(context.Context, []string) ([]byte, bool) { return []byte(`{"valid":true}`), false }
	if _, valid := githubSafetyRead(t.Context(), githubRequestFixture(), githubFullEvidence, failed); valid {
		t.Fatal("failed GitHub process accepted")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if result, complete := githubSafetyLive(ctx, githubRequestFixture()); complete || result.Passed {
		t.Fatal("cancelled live GitHub read passed")
	}
	called := false
	runner := func(context.Context, []string) ([]byte, bool) { called = true; return nil, false }
	if _, valid := githubSafetyRead(ctx, githubRequestFixture(), githubFullEvidence, runner); valid || called {
		t.Fatal("cancelled GitHub read executed")
	}
	if _, valid := githubSafetyRead(t.Context(), githubRequestFixture(), "invalid-kind", runner); valid || called {
		t.Fatal("unknown GitHub read executed")
	}
}
