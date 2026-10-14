package main

import (
	"errors"
	"io/fs"
	"os"
	"slices"
)

const (
	generatedEntryLimit   = 100000
	generatedGitDirectory = ".git"
)

type generatedInventory struct {
	paths    []string
	complete bool
}

var errGeneratedLimit = errors.New("generated artifact inventory limit")

func generatedArtifacts(root *os.Root, entryLimit int) generatedInventory {
	result := generatedInventory{paths: nil, complete: false}
	for _, name := range generatedExactPaths() {
		if _, err := root.Stat(name); err == nil {
			result.paths = append(result.paths, name)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return result
		}
	}
	entries := 0
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkError error) error {
		entries++
		if walkError != nil {
			return walkError
		}
		if entries > entryLimit {
			return errGeneratedLimit
		}
		if entry.IsDir() && entry.Name() == generatedGitDirectory {
			return fs.SkipDir
		}
		if generatedArtifactPath(name) {
			result.paths = append(result.paths, name)
		}
		return nil
	})
	slices.Sort(result.paths)
	result.paths = slices.Compact(result.paths)
	result.complete = err == nil
	return result
}
