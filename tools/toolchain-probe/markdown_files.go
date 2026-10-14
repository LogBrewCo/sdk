package main

import (
	"errors"
	"io/fs"
	"os"
	"slices"
	"strings"
)

const (
	markdownFileLimit  = 4096
	markdownEntryLimit = 100000
	markdownByteLimit  = 64 << 20
)

var errMarkdownInventory = errors.New("invalid Markdown inventory")

func markdownFiles(root *os.Root) ([]string, bool) {
	return markdownFilesWithinLimits(root, markdownFileLimit, markdownEntryLimit)
}

func markdownFilesWithinLimits(root *os.Root, fileLimit, entryLimit int) ([]string, bool) {
	var files []string
	entries := 0
	err := fs.WalkDir(root.FS(), ".", func(name string, entry fs.DirEntry, walkError error) error {
		entries++
		if walkError != nil || entries > entryLimit {
			return errMarkdownInventory
		}
		if entry.IsDir() {
			if markdownIgnoredDirectory(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(name, ".md") {
			return nil
		}
		if len(files) >= fileLimit || !markdownRegularFile(root, name) {
			return errMarkdownInventory
		}
		files = append(files, name)
		return nil
	})
	return files, err == nil && len(files) > 0
}

func markdownRegularFile(root *os.Root, name string) bool {
	resolved, valid := markdownLeafPath(root, name)
	if !valid {
		return false
	}
	info, err := root.Stat(resolved)
	return err == nil && info.Mode().IsRegular()
}

func markdownIgnoredDirectory(name string) bool {
	return slices.Contains([]string{
		".git", ".gradle", ".pytest_cache", ".ruff_cache", "bin", "build", "dist",
		"node_modules", "obj", "target", "vendor",
	}, name)
}
