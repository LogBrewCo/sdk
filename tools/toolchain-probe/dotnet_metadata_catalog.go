package main

import (
	"os"
	"strings"
)

const dotnetMetadataInventoryLimit = 128

func metadataDirectoryEntries(root *os.Root, name string) ([]os.DirEntry, bool) {
	directory, err := root.OpenRoot(name)
	if err != nil {
		return nil, false
	}
	entries, read := readPythonDirectory(directory, dotnetMetadataInventoryLimit)
	closeError := directory.Close()
	return entries, read && closeError == nil
}

func checkDotnetMetadataCatalog(root *os.Root, policies map[string]dotnetMetadataPolicy) bool {
	entries, read := metadataDirectoryEntries(root, dotnetMetadataSource)
	if !read {
		return false
	}
	expected := make(map[string]string, len(policies))
	for id := range policies {
		expected[id] = dotnetMetadataSource + id + "/" + id + dotnetMetadataProject
	}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			return false
		}
		if entry.IsDir() && !checkDotnetMetadataDirectory(root, dotnetMetadataSource+entry.Name(), expected) {
			return false
		}
	}
	return len(expected) == 0
}

func checkDotnetMetadataDirectory(root *os.Root, name string, expected map[string]string) bool {
	entries, read := metadataDirectoryEntries(root, name)
	if !read {
		return false
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), dotnetMetadataProject) {
			continue
		}
		manifest := name + "/" + entry.Name()
		data, readable := readReleaseMetadata(root, manifest)
		properties := dotnetProjectProperties(data)
		if !readable || properties == nil {
			return false
		}
		if strings.EqualFold(properties.value(dotnetMetadataPackable), "false") {
			continue
		}
		id := properties.value(dotnetMetadataID)
		if expected[id] != manifest {
			return false
		}
		delete(expected, id)
	}
	return true
}
