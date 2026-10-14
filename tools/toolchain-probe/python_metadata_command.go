package main

import (
	"errors"
	"os"
	"strings"
)

const (
	pythonMetadataEntryLimit = 128
	pythonMetadataDirectory  = "python"
	pythonMetadataManifest   = "pyproject.toml"
)

func checkPythonMetadataRepository(repository *os.Root) bool {
	root, err := repository.OpenRoot(pythonMetadataDirectory)
	if err != nil {
		return false
	}
	valid := checkPythonMetadataInventory(root)
	for _, spec := range pythonReleaseCatalog() {
		if valid {
			valid = checkPythonMetadataPackage(root, spec)
		}
	}
	closeError := root.Close()
	return valid && closeError == nil
}

func checkPythonMetadataInventory(root *os.Root) bool {
	entries, readable := readPythonDirectory(root, pythonMetadataEntryLimit)
	expected := make(map[string]bool)
	for _, spec := range pythonReleaseCatalog() {
		expected[spec.directory] = true
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "logbrew_") {
			continue
		}
		info, err := root.Lstat(entry.Name() + "/" + pythonMetadataManifest)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || !entry.IsDir() || !expected[entry.Name()] {
			return false
		}
	}
	return readable
}

func checkPythonMetadataPackage(root *os.Root, spec pythonReleaseSpec) bool {
	data, readable := readReleaseMetadata(root, spec.directory+"/"+pythonMetadataManifest)
	if !readable || !validPythonMetadata(data, spec.id) {
		return false
	}
	module := strings.ReplaceAll(spec.id, "-", "_")
	for _, name := range []string{
		policyRootGuide, "src/" + module + "/py.typed", "src/" + module + "/examples/__main__.py",
	} {
		if !releaseMetadataFileExists(root, spec.directory+"/"+name) {
			return false
		}
	}
	return true
}
