//go:build darwin || linux

package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestPublishDirectoryNeverReplacesExistingEntry(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{nugetOutputExistingDirectory, "file", "existing-symlink"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			directory := t.TempDir()
			root := publishFixtureRoot(t, directory)
			if err := root.Mkdir("staged", pythonManifestDirectoryMode); err != nil {
				t.Fatal(err)
			}
			createExistingPublication(t, kind, filepath.Join(directory, "ready"))
			assertPublicationUnchanged(t, root)
		})
	}
}

func assertPublicationUnchanged(t *testing.T, root *os.Root) {
	t.Helper()
	before, err := root.Lstat("ready")
	if err != nil || publishDirectory(root, "staged", "ready") {
		t.Fatal("publication replaced an existing entry")
	}
	after, err := root.Lstat("ready")
	if err != nil || !os.SameFile(before, after) {
		t.Fatal("publication changed the existing entry")
	}
	if _, err := root.Lstat("staged"); err != nil {
		t.Fatal("failed publication removed the caller's staging directory")
	}
}

func publishFixtureRoot(t *testing.T, directory string) *os.Root {
	t.Helper()
	root, err := os.OpenRoot(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeError := root.Close(); closeError != nil {
			t.Error(closeError)
		}
	})
	return root
}

func createExistingPublication(t *testing.T, kind, target string) {
	t.Helper()
	var err error
	switch kind {
	case nugetOutputExistingDirectory:
		err = os.Mkdir(target, pythonManifestDirectoryMode)
	case "file":
		err = os.WriteFile(target, []byte("keep"), fixtureReceiptMode)
	case "existing-symlink":
		err = os.Symlink(t.TempDir(), target)
	default:
		t.Fatal("unknown publication fixture")
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestPublishDirectoryHasOneWinner(t *testing.T) {
	t.Parallel()
	root := publishFixtureRoot(t, t.TempDir())
	const contenders = 8
	results := make(chan bool, contenders)
	var workers sync.WaitGroup
	for index := range contenders {
		name := string(rune('a' + index))
		if err := root.Mkdir(name, pythonManifestDirectoryMode); err != nil {
			t.Fatal(err)
		}
		workers.Go(func() { results <- publishDirectory(root, name, "ready") })
	}
	workers.Wait()
	close(results)
	winners := 0
	for published := range results {
		if published {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("expected one complete publication, got %d", winners)
	}
}
