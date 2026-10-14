package main

import (
	"io/fs"
	"os"
	"path"
	"strings"
)

const (
	jsBuildDirectory        = "build"
	jsDistributionDirectory = "dist"
	jsModulesDirectory      = "node_modules"
)

func jsSyntaxFiles(root *os.Root) ([]string, bool) {
	names := make([]string, 0)
	remaining := markdownByteLimit
	entries := 0
	err := fs.WalkDir(root.FS(), "js", func(name string, entry fs.DirEntry, walkError error) error {
		entries++
		if walkError != nil || entries > markdownFileLimit {
			return fs.ErrInvalid
		}
		if entry.IsDir() {
			if jsSyntaxSkip(entry.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		if !jsSyntaxExtension(name) {
			return nil
		}
		data, valid := jsSyntaxRead(root, name, entry)
		if !valid || len(data) > remaining {
			return fs.ErrInvalid
		}
		remaining -= len(data)
		names = append(names, name)
		return nil
	})
	return names, err == nil && len(names) > 0
}

func jsSyntaxSkip(name string) bool {
	switch name {
	case jsModulesDirectory, jsDistributionDirectory, jsBuildDirectory, "coverage":
		return true
	default:
		return false
	}
}

func jsSyntaxExtension(name string) bool {
	switch strings.ToLower(path.Ext(name)) {
	case ".cjs", ".js", ".mjs":
		return true
	default:
		return false
	}
}

func jsSyntaxRead(root *os.Root, name string, entry fs.DirEntry) ([]byte, bool) {
	if !entry.Type().IsRegular() {
		return nil, false
	}
	return brandReadAsset(root, name, brandSVGByteLimit)
}
