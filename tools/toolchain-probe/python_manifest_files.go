package main

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

func createPythonReleaseManifest(directory string, selection pythonReleaseSelection) (map[string]any, bool) {
	if !filepath.IsAbs(directory) || !validPythonReleaseSelection(selection) {
		return nil, false
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, false
	}
	document, valid := pythonManifestAtRoot(root, selection)
	closeError := root.Close()
	return document, valid && closeError == nil
}

func pythonManifestAtRoot(root *os.Root, selection pythonReleaseSelection) (map[string]any, bool) {
	packages := make([]any, 0, len(pythonReleaseCatalog()))
	for _, spec := range pythonReleaseCatalog() {
		packageRoot, err := root.OpenRoot(spec.directory)
		if err != nil {
			return nil, false
		}
		entry, valid := pythonManifestPackage(packageRoot, spec, selection.versions[spec.id])
		closeError := packageRoot.Close()
		if !valid || closeError != nil {
			return nil, false
		}
		packages = append(packages, entry)
	}
	return map[string]any{
		pythonManifestSchemaKey: json.Number("1"), pythonManifestCommitKey: selection.sourceCommit,
		pythonManifestPackages: packages,
	}, true
}

func pythonManifestPackage(root *os.Root, spec pythonReleaseSpec, version string) (map[string]any, bool) {
	if !validPythonReleaseDirectory(root, spec, version) {
		return nil, false
	}
	entry := map[string]any{"id": spec.id, pythonManifestVersion: version}
	for _, kind := range []string{pythonWheel, pythonSdist} {
		relative := pythonReleaseArtifactPath(spec, version, kind)
		input, err := openRootCheckInput(root, path.Base(relative))
		if err != nil {
			return nil, false
		}
		data, readable := readCheckInputFile(input)
		receipt, valid := inspectPythonArchive(data, kind, spec.id, version)
		if !readable || !valid {
			return nil, false
		}
		entry[kind] = map[string]any{pythonManifestFile: relative, pythonManifestHash: receipt.SHA256}
	}
	return entry, true
}

func validPythonReleaseDirectory(root *os.Root, spec pythonReleaseSpec, version string) bool {
	entries, valid := readPythonDirectory(root, pythonArchiveMemberLimit)
	if !valid {
		return false
	}
	wheel := path.Base(pythonReleaseArtifactPath(spec, version, pythonWheel))
	sdist := path.Base(pythonReleaseArtifactPath(spec, version, pythonSdist))
	count := 0
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasSuffix(name, ".whl") && !strings.HasSuffix(name, ".tar.gz") {
			continue
		}
		if name != wheel && name != sdist || !entry.Type().IsRegular() {
			return false
		}
		count++
	}
	return count == pythonReleaseFileCount
}

func writePythonManifestFile(filename string, data []byte) bool {
	if !filepath.IsAbs(filename) || !strings.HasSuffix(filename, ".json") || len(data) > pythonManifestLimit {
		return false
	}
	root, err := os.OpenRoot(filepath.Dir(filename))
	if err != nil {
		return false
	}
	written := writePythonManifestAtRoot(root, filepath.Base(filename), data)
	closeError := root.Close()
	return written && closeError == nil
}

func writePythonManifestAtRoot(root *os.Root, name string, data []byte) bool {
	if !replacePythonOutput(root, name, data, pythonTemporaryFileMode) {
		return false
	}
	input, err := openRootCheckInput(root, name)
	if err != nil {
		return false
	}
	actual, readable := readCheckInputFile(input)
	return readable && bytes.Equal(actual, data)
}

// Never follow an existing output symlink or replace a non-regular file.
// The caller's explicit parent root bounds temporary creation and rename.
func replacePythonOutput(root *os.Root, name string, data []byte, mode fs.FileMode) bool {
	info, err := root.Lstat(name)
	if err != nil && !errors.Is(err, os.ErrNotExist) || err == nil && !info.Mode().IsRegular() {
		return false
	}
	temporaryName := "." + name + "." + rand.Text() + ".tmp"
	file, err := root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, pythonTemporaryFileMode)
	if err != nil {
		return false
	}
	written := writePythonOutputFile(file, data, mode)
	if written {
		err = root.Rename(temporaryName, name)
	}
	removeError := root.Remove(temporaryName)
	return written && err == nil && (removeError == nil || errors.Is(removeError, os.ErrNotExist))
}

func writePythonOutputFile(file *os.File, data []byte, mode fs.FileMode) bool {
	count, writeError := file.Write(data)
	modeError := file.Chmod(mode)
	syncError := file.Sync()
	closeError := file.Close()
	return count == len(data) && writeError == nil && modeError == nil && syncError == nil && closeError == nil
}
