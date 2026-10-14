package main

import (
	"errors"
	"io"
	"os"
	"path"
	"strings"
)

const (
	brandPNGExtension = ".png"
	brandSVGExtension = ".svg"
)

func brandDirectoryInventory(root *os.Root, assets []brandAssetIdentity, entryLimit int) bool {
	if entryLimit < 1 || entryLimit > markdownFileLimit {
		return false
	}
	directory, err := root.Open(brandAssetDirectory)
	if err != nil {
		return false
	}
	entries, readError := directory.ReadDir(entryLimit + 1)
	closeError := directory.Close()
	if readError != nil && !errors.Is(readError, io.EOF) || closeError != nil || len(entries) > entryLimit {
		return false
	}
	expected := make(map[string]bool, len(assets))
	for _, asset := range assets {
		expected[asset.name] = true
	}
	seen := 0
	for _, entry := range entries {
		extension := strings.ToLower(path.Ext(entry.Name()))
		if extension != brandPNGExtension && extension != brandSVGExtension {
			continue
		}
		name := path.Join(brandAssetDirectory, entry.Name())
		info, statError := root.Stat(name)
		if statError != nil || !info.Mode().IsRegular() || !expected[name] {
			return false
		}
		seen++
	}
	return seen == len(expected)
}
