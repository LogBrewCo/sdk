package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	gitPushFixture          = "push"
	gitFirstFixturePath     = "python/first.py"
	gitSecondFixturePath    = "go/second.go"
	gitFixtureDirectoryMode = 0o700
	gitReadFixtureLimit     = 8192
	gitSpacedFixturePath    = "python/with space.py"
)

func TestChangedGitSnapshots(t *testing.T) {
	t.Parallel()
	repo := t.TempDir()
	fixtureGit(t, repo, "init", "--initial-branch=main")
	fixtureGitFile(t, repo, gitFirstFixturePath)
	first := commitGitFixture(t, repo, "Initial fixture")
	fixtureGit(t, repo, "update-ref", "refs/remotes/origin/main", first)
	fixtureGitFile(t, repo, gitSecondFixturePath)
	second := commitGitFixture(t, repo, "Second fixture")
	fixtureGit(t, repo, "checkout", "-b", "base", first)
	fixtureGitFile(t, repo, "ruby/base.rb")
	commitGitFixture(t, repo, "Independent base fixture")
	fixtureGit(t, repo, "update-ref", "refs/remotes/origin/main", "HEAD")
	fixtureGit(t, repo, "checkout", "main")
	for _, test := range []struct {
		name, event, before, head, base, paths string
	}{
		{"root", gitPushFixture, "", first, "", gitFirstFixturePath},
		{"zero base", gitPushFixture, strings.Repeat("0", len(first)), first, "", gitFirstFixturePath},
		{gitPushFixture, gitPushFixture, first, second, "", gitSecondFixturePath},
		{"pull request", "pull_request", "", second, "main", gitSecondFixturePath},
		{"local head", "", "", "", "", gitSecondFixturePath},
		{"empty diff", gitPushFixture, second, second, "", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			snapshot, ok := changedGitSnapshot(t.Context(), repo, gitSelection{
				event: test.event, before: test.before, head: test.head, base: test.base,
			})
			if !ok || strings.Join(snapshot.paths, " ") != test.paths || snapshot.fullUnitDiscovery {
				t.Fatalf("Git snapshot = %+v, success=%v, want %q", snapshot, ok, test.paths)
			}
		})
	}
	for _, revision := range []string{"missing-revision", "--output=unexpected", "HEAD\nunknown"} {
		if snapshot, ok := changedGitSnapshot(t.Context(), repo,
			gitSelection{event: gitPushFixture, before: "", head: revision, base: ""}); ok || snapshot.paths != nil {
			t.Fatalf("invalid revision accepted: %+v", snapshot)
		}
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, ok := changedGitSnapshot(cancelled, repo, gitSelection{event: "", before: "", head: "", base: ""}); ok {
		t.Fatal("cancelled Git read succeeded")
	}
}

func TestChangedGitPreservesPaths(t *testing.T) {
	t.Parallel()
	repo := t.TempDir()
	fixtureGit(t, repo, "init")
	for _, path := range []string{gitSpacedFixturePath, "go/with\nnewline.go"} {
		fixtureGitFile(t, repo, path)
	}
	commitGitFixture(t, repo, "Path fixture")
	snapshot, valid := changedGitSnapshot(t.Context(), repo, gitSelection{event: "", before: "", head: "", base: ""})
	if !valid || !slices.Equal(snapshot.paths, []string{"go/with\nnewline.go", gitSpacedFixturePath}) {
		t.Fatalf("Git path boundaries lost: %+v, success=%v", snapshot, valid)
	}
	fixtureGit(t, repo, "mv", "--", gitSpacedFixturePath, "go/with space.go")
	commitGitFixture(t, repo, "Cross-family rename")
	snapshot, valid = changedGitSnapshot(t.Context(), repo,
		gitSelection{event: gitPushFixture, before: "HEAD~1", head: "", base: ""})
	if !valid || !slices.Equal(snapshot.paths, []string{"go/with space.go", gitSpacedFixturePath}) {
		t.Fatalf("Git rename lost a consumer family: %+v, success=%v", snapshot, valid)
	}
}

func TestDeletedUnitSelection(t *testing.T) {
	t.Parallel()
	repo := t.TempDir()
	fixtureGit(t, repo, "init")
	fixtureGitFile(t, repo, "tests/test_removed.py")
	before := commitGitFixture(t, repo, "Initial test")
	fixtureGit(t, repo, "rm", "--", "tests/test_removed.py")
	commitGitFixture(t, repo, "Remove test")
	snapshot, ok := changedGitSnapshot(t.Context(), repo,
		gitSelection{event: gitPushFixture, before: before, head: "", base: ""})
	if !ok {
		t.Fatal("deleted test snapshot failed")
	}
	var output strings.Builder
	if snapshot.write(&output) != exitOK || !strings.HasSuffix(output.String(), "run_all=true\nmodules=\n") {
		t.Fatalf("deleted test must use full discovery, got %q", output.String())
	}
}

func TestGitSnapshotRecords(t *testing.T) {
	t.Parallel()
	for _, input := range []string{
		"M", "M\x00go/a.go", "M\x00", "M\x00\x00", "?\x00go/a.go\x00",
		"R100\x00go/a.go\x00go/b.go\x00", "X\x00go/a.go\x00", "M\x00go/a.go\x00D\x00",
	} {
		if snapshot, ok := parseGitSnapshot([]byte(input)); ok || snapshot.paths != nil {
			t.Fatalf("invalid Git record accepted: %q", input)
		}
	}
	snapshot, ok := parseGitSnapshot([]byte("D\x00tests/test_removed.py\x00M\x00python/source.py\x00"))
	var output strings.Builder
	if !ok || !snapshot.fullUnitDiscovery || snapshot.write(&output) != exitOK ||
		!strings.Contains(output.String(), "python=true\n") ||
		!strings.HasSuffix(output.String(), "run_all=true\nmodules=\n") {
		t.Fatalf("removed tests lost surviving family coverage: %q", output.String())
	}
}

func commitGitFixture(t *testing.T, repo, message string) string {
	t.Helper()
	fixtureGit(t, repo, "add", ".")
	fixtureGit(t, repo, "commit", "-m", message)
	return fixtureGit(t, repo, "rev-parse", "HEAD")
}

func fixtureGitFile(t *testing.T, repo, path string) {
	t.Helper()
	file := filepath.Join(repo, path)
	if err := os.MkdirAll(filepath.Dir(file), gitFixtureDirectoryMode); err != nil {
		t.Fatal(err)
	}
	// Reviewed 2026-09-05: the caller's t.TempDir owns each fixed fixture path.
	if err := os.WriteFile(file, []byte("fixture\n"), fixtureReceiptMode); err != nil {
		t.Fatal(err)
	}
}

func fixtureGit(t *testing.T, repo string, arguments ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), commandTimeout)
	defer cancel()
	args := append([]string{
		"-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
		"-c", "user.name=SDK Fixture", "-c", "user.email=fixture@example.test",
	}, arguments...)
	// Reviewed 2026-09-05: only fixed Git operations in an owned temporary repo.
	//nolint:gosec // G204: source-controlled arguments; no shell or remote commands.
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = repo
	command.Env = []string{"PATH=" + os.Getenv("PATH"), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null"}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("fixture Git failed: %v", err)
	}
	return strings.TrimSpace(string(output))
}

func TestGitOutputBound(t *testing.T) {
	t.Parallel()
	cancelled := false
	output := boundedOutput{
		cancel: func() { cancelled = true }, data: nil, limited: false, limit: gitReadFixtureLimit,
	}
	if count, err := output.Write(make([]byte, gitReadFixtureLimit)); err != nil || count != gitReadFixtureLimit ||
		len(output.data) != gitReadFixtureLimit || cancelled || output.limited {
		t.Fatal("bounded Git output rejected its exact limit")
	}
	if count, err := output.Write([]byte{1}); err != nil || count != 1 || !cancelled || !output.limited ||
		len(output.data) != gitReadFixtureLimit {
		t.Fatal("oversized Git output was not capped and cancelled")
	}
}
