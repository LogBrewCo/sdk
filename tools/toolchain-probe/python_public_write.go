package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
)

const pythonBundleDirectoryMode = 0o700

// Publish artifacts and receipts through one no-replace directory rename.
// Failed writes clean only the staging directory created by this call.
func writePythonPublicBundle(destination string, bundle pythonPublicBundle) bool {
	files, valid := pythonPublicOutputFiles(bundle)
	return valid && writeReleaseBundle(destination, func(root *os.Root) bool {
		return writePythonPublicAtRoot(root, bundle, files)
	})
}

func writeReleaseBundle(destination string, write func(*os.Root) bool) bool {
	if write == nil || !filepath.IsAbs(destination) || filepath.Clean(destination) != destination ||
		!directDirectoryName(filepath.Base(destination)) || destination == string(filepath.Separator) {
		return false
	}
	parent, err := os.OpenRoot(filepath.Dir(destination))
	if err != nil {
		return false
	}
	written := stageReleaseBundle(parent, filepath.Base(destination), write)
	closeError := parent.Close()
	return written && closeError == nil
}

func stageReleaseBundle(parent *os.Root, name string, write func(*os.Root) bool) bool {
	if _, err := parent.Lstat(name); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	staged := ".release-" + rand.Text() + ".tmp"
	if err := parent.Mkdir(staged, pythonBundleDirectoryMode); err != nil {
		return false
	}
	identity, statError := parent.Lstat(staged)
	if statError != nil {
		return false
	}
	root, openError := parent.OpenRoot(staged)
	written := false
	if openError == nil {
		written = write(root)
		closeError := root.Close()
		written = written && closeError == nil
	}
	published := written && publishDirectory(parent, staged, name)
	cleaned := true
	if !published {
		cleaned = removePythonStaging(parent, staged, identity)
	}
	return published && cleaned && syncPythonDirectory(parent, ".")
}

func removePythonStaging(parent *os.Root, name string, identity fs.FileInfo) bool {
	current, err := parent.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	return err == nil && os.SameFile(identity, current) && parent.RemoveAll(name) == nil
}

func writePythonPublicAtRoot(root *os.Root, bundle pythonPublicBundle, files map[string][]byte) bool {
	for _, spec := range pythonReleaseCatalog() {
		if err := root.Mkdir(spec.directory, pythonBundleDirectoryMode); err != nil {
			return false
		}
	}
	for name, data := range files {
		mode := fs.FileMode(pythonNormalizedFileMode)
		if name == pythonPublicManifestName || name == pythonPublicReceiptName {
			mode = pythonTemporaryFileMode
		}
		if !createVerifiedReleaseOutput(root, name, data, mode) {
			return false
		}
	}
	selection, valid := pythonManifestIdentity(bundle.manifest)
	actual, verified := pythonManifestAtRoot(root, selection)
	if !valid || !verified || !reflect.DeepEqual(actual, bundle.manifest) {
		return false
	}
	for _, spec := range pythonReleaseCatalog() {
		if !syncPythonDirectory(root, spec.directory) {
			return false
		}
	}
	return syncPythonDirectory(root, ".")
}

func createVerifiedReleaseOutput(root *os.Root, name string, data []byte, mode fs.FileMode) bool {
	file, err := root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil || !writePythonOutputFile(file, data, mode) {
		return false
	}
	input, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	actual, readable := readCheckBytes(input, int64(max(1, len(data))))
	return readable && bytes.Equal(data, actual)
}

func syncPythonDirectory(root *os.Root, name string) bool {
	file, err := root.Open(name)
	if err != nil {
		return false
	}
	syncError := file.Sync()
	closeError := file.Close()
	return syncError == nil && closeError == nil
}
