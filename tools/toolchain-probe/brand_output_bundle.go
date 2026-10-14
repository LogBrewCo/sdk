package main

import (
	"os"
	"path"
	"slices"
)

func brandWriteOutputBundle(destination string, outputs map[string][]byte) bool {
	if !brandOutputPolicy(outputs) {
		return false
	}
	return writeReleaseBundle(destination, func(root *os.Root) bool {
		names := make([]string, 0, len(outputs))
		for name := range outputs {
			names = append(names, name)
		}
		slices.Sort(names)
		for _, name := range names {
			if !createVerifiedReleaseOutput(root, path.Base(name), outputs[name], pythonNormalizedFileMode) {
				return false
			}
		}
		return true
	})
}
