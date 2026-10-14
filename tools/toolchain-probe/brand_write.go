package main

import (
	"errors"
	"os"
	"slices"
)

func brandWriteOutputs(root *os.Root, outputs map[string][]byte) bool {
	if !brandOutputPolicy(outputs) || !brandWriteTargets(root, outputs) {
		return false
	}
	names := make([]string, 0, len(outputs))
	for name := range outputs {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if !brandReplaceFile(root, name, outputs[name]) {
			return false
		}
	}
	return true
}

func brandWriteTargets(root *os.Root, outputs map[string][]byte) bool {
	for _, directory := range []string{"assets", brandAssetDirectory} {
		info, err := root.Lstat(directory)
		if err != nil || !info.IsDir() {
			return false
		}
	}
	for name := range outputs {
		info, err := root.Lstat(name)
		if err != nil && !errors.Is(err, os.ErrNotExist) || err == nil && !info.Mode().IsRegular() {
			return false
		}
	}
	return true
}
