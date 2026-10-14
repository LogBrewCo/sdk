package main

import (
	"crypto/rand"
	"errors"
	"os"
	"path"
)

func brandReplaceFile(root *os.Root, name string, data []byte) bool {
	if _, allowed := brandGeneratedAssets()[name]; !allowed || len(data) == 0 || len(data) > brandSVGByteLimit {
		return false
	}
	info, err := root.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) || err == nil && !info.Mode().IsRegular() {
		return false
	}
	staged := path.Join(brandAssetDirectory, ".brand-"+rand.Text()+".tmp")
	if !createVerifiedReleaseOutput(root, staged, data, pythonNormalizedFileMode) {
		return false
	}
	if err := root.Rename(staged, name); err != nil {
		if removalError := root.Remove(staged); removalError != nil {
			return false
		}
		return false
	}
	return syncPythonDirectory(root, brandAssetDirectory)
}
