package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const (
	confidentialityFixtureTerm  = "pass" + "word"
	confidentialityFixturePath  = "unsafe.txt"
	confidentialityGuide        = "AGENTS.md"
	confidentialityPackageGuide = "js/AGENTS.md"
	confidentialityNestedGuide  = "js/AGENTS.override.md"
	confidentialityIgnoredPath  = "ignored.txt"
	confidentialityIgnoreFile   = ".gitignore"
	confidentialityPlanFixture  = "plans/local.md"
	confidentialityGitInit      = "init"
)

func confidentialityFixture(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for name, body := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), gitFixtureDirectoryMode); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), fixtureReceiptMode); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func TestConfidentialityInventory(t *testing.T) {
	t.Parallel()
	for _, gitRepository := range []bool{false, true} {
		root := confidentialityFixture(t, map[string]string{
			policyRootGuide: "public integration", confidentialityGuide: "public guide",
			confidentialityNestedGuide: "public nested guide", "with space.txt": "public text",
			"node_modules/library.js": confidentialityFixtureTerm,
			"pkg.egg-info/metadata":   confidentialityFixtureTerm,
			"LICENSE":                 confidentialityFixtureTerm, "assets/image.PNG": confidentialityFixtureTerm,
			".agents/local.md": confidentialityFixtureTerm,
		})
		if gitRepository {
			fixtureGit(t, root, confidentialityGitInit)
		}
		files, err := confidentialityFiles(t.Context(), root)
		if err != nil || !slices.Equal(files, []string{
			confidentialityGuide, policyRootGuide, confidentialityNestedGuide, "with space.txt",
		}) {
			t.Fatalf("inventory=%q, error=%v", files, err)
		}
	}
}

func TestConfidentialityGitScope(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		confidentialityIgnoreFile:  "AGENTS.md\nplans/\nignored.txt\n",
		confidentialityGuide:       confidentialityFixtureTerm,
		confidentialityPlanFixture: confidentialityFixtureTerm,
		confidentialityIgnoredPath: confidentialityFixtureTerm,
		confidentialityFixturePath: confidentialityFixtureTerm,
	})
	fixtureGit(t, root, confidentialityGitInit)
	files, err := confidentialityFiles(t.Context(), root)
	if err != nil || !slices.Equal(files, []string{confidentialityIgnoreFile, confidentialityFixturePath}) {
		t.Fatalf("ignored scope=%q, error=%v", files, err)
	}
	fixtureGit(t, root, "add", "--force", confidentialityIgnoredPath)
	files, err = confidentialityFiles(t.Context(), root)
	if err != nil || !slices.Contains(files, confidentialityIgnoredPath) {
		t.Fatal("tracked ignored file escaped inventory")
	}
	if removeError := os.Remove(filepath.Join(root, confidentialityIgnoredPath)); removeError != nil {
		t.Fatal(removeError)
	}
	files, err = confidentialityFiles(t.Context(), root)
	if err != nil || slices.Contains(files, confidentialityIgnoredPath) {
		t.Fatal("deleted tracked file was not handled")
	}
}

func TestConfidentialityPlanningPaths(t *testing.T) {
	t.Parallel()
	for _, ignored := range []bool{false, true} {
		files := map[string]string{
			confidentialityResearchDir + "/transport.md": "source notes",
			"docs/private-plans/task.md":                 "task notes", policyMemoryPath: "notes",
			".agents/local.md": "local", "CLAUDE.md": "guide",
			confidentialityPlanFixture: "local", "skills-lock.json": "{}",
		}
		if ignored {
			files[confidentialityIgnoreFile] = strings.Join(confidentialityPlanningPaths(), "\n") + "\n"
		}
		root := confidentialityFixture(t, files)
		if ignored {
			fixtureGit(t, root, confidentialityGitInit)
		}
		failures, err := confidentialityPlanning(t.Context(), root)
		want := len(confidentialityPlanningPaths())
		if ignored {
			want = 0
		}
		if err != nil || len(failures) != want {
			t.Fatalf("planning findings=%q, error=%v", failures, err)
		}
		for index, finding := range failures {
			if finding != confidentialityPlanningPaths()[index] {
				t.Fatalf("planning contract changed: %q", finding)
			}
		}
	}
}

func TestConfidentialityInventoryRejectsUnsafeReads(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{})
	outside := confidentialityFixture(t, map[string]string{confidentialityFixturePath: "outside"})
	if err := os.Symlink(filepath.Join(outside, confidentialityFixturePath), filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := confidentialityFiles(t.Context(), root); err == nil {
		t.Fatal("inventory followed a symlink")
	}
	cancelled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := confidentialityFiles(cancelled, root); err == nil {
		t.Fatal("cancelled inventory succeeded")
	}
	if _, err := confidentialityPlanning(cancelled, root); err == nil {
		t.Fatal("cancelled planning check succeeded")
	}
	if _, err := confidentialityFiles(t.Context(), filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing root succeeded")
	}
}

func TestConfidentialityPathBoundaries(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"../outside-inventory", "/absolute", "a/../b", "a//b", "./a", "a\nname", ""} {
		if _, err := confidentialityGitPaths([]byte(name + "\x00")); err == nil {
			t.Fatalf("unsafe inventory path accepted: %q", name)
		}
	}
	if _, err := confidentialityGitPaths([]byte("unterminated")); err == nil {
		t.Fatal("unterminated Git output accepted")
	}
	files, err := confidentialityGitPaths([]byte("b\x00a\x00b\x00"))
	if err != nil || !slices.Equal(files, []string{"a", "b"}) {
		t.Fatalf("duplicate inventory=%q, error=%v", files, err)
	}
}

func TestConfidentialityIgnoresAmbientGitRouting(t *testing.T) {
	root := confidentialityFixture(t, map[string]string{
		confidentialityFixturePath: confidentialityFixtureTerm,
	})
	foreign := confidentialityFixture(t, map[string]string{"foreign.txt": "unrelated"})
	fixtureGit(t, root, confidentialityGitInit)
	fixtureGit(t, foreign, confidentialityGitInit)
	fixtureGit(t, foreign, "add", "foreign.txt")
	t.Setenv("GIT_DIR", filepath.Join(foreign, ".git"))
	t.Setenv("GIT_WORK_TREE", foreign)
	t.Setenv("GIT_INDEX_FILE", filepath.Join(foreign, ".git", "index"))
	files, err := confidentialityFiles(t.Context(), root)
	if err != nil || !slices.Equal(files, []string{confidentialityFixturePath}) {
		t.Fatalf("ambient Git routing changed the scanned root: %q, %v", files, err)
	}
}

func TestConfidentialityRejectsTrackedIgnoredPlanning(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		confidentialityIgnoreFile: "plans/\n", "plans/tracked.md": "task state",
	})
	fixtureGit(t, root, confidentialityGitInit)
	fixtureGit(t, root, "add", "--force", "plans/tracked.md")
	findings, err := confidentialityPlanning(t.Context(), root)
	if err != nil || !slices.Equal(findings, []string{"plans"}) {
		t.Fatalf("tracked planning escaped through an ignore rule: %q, %v", findings, err)
	}
}

func TestConfidentialityDoesNotWalkAroundBrokenGit(t *testing.T) {
	t.Parallel()
	root := confidentialityFixture(t, map[string]string{
		".git": "gitdir: missing-administration\n", "nested/file.txt": "public text",
	})
	for _, directory := range []string{root, filepath.Join(root, "nested")} {
		if _, err := confidentialityFiles(t.Context(), directory); err == nil {
			t.Fatal("failed Git inventory fell back to an incomplete filesystem walk")
		}
	}
}

func TestConfidentialityDoesNotScanBareGitStorage(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	fixtureGit(t, root, confidentialityGitInit, "--bare")
	if _, err := confidentialityFiles(t.Context(), root); err == nil {
		t.Fatal("bare repository administration was treated as a public working tree")
	}
}
