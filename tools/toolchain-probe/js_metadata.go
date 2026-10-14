package main

import (
	"os"
	"reflect"
	"strings"
)

func checkJSMetadata(root *os.Root) bool {
	return checkJSMetadataVersions(root, nil)
}

func checkJSMetadataVersions(root *os.Root, versions map[string]string) bool {
	packages := jsMetadataPackages()
	if !checkJSMetadataCatalog(root, packages) {
		return false
	}
	for directory, name := range packages {
		data, readable := readReleaseMetadata(root, directory+"/"+jsMetadataManifest)
		if !readable || !releaseMetadataFileExists(root, directory+"/"+policyRootGuide) ||
			!validJSMetadata(data, name, versions[name]) {
			return false
		}
	}
	return true
}

func checkJSMetadataCatalog(root *os.Root, expected map[string]string) bool {
	entries, readable := metadataDirectoryEntries(root, jsMetadataDirectory)
	if !readable {
		return false
	}
	count := 0
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "logbrew-") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return false
		}
		if !entry.IsDir() {
			continue
		}
		directory := jsMetadataDirectory + "/" + entry.Name()
		info, err := root.Lstat(directory + "/" + jsMetadataManifest)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() || expected[directory] == "" {
			return false
		}
		count++
	}
	return count == len(expected)
}

func jsMetadataOverrideCheck(arguments []string) func(*os.Root) bool {
	packages := jsMetadataPackages()
	if len(arguments) > len(packages) {
		return nil
	}
	known := make(map[string]bool, len(packages))
	for _, name := range packages {
		known[name] = true
	}
	versions := make(map[string]string, len(arguments))
	for _, argument := range arguments {
		name, version, found := strings.Cut(argument, "=")
		if !found || !known[name] || versions[name] != "" || !validPythonPackageVersion(version) {
			return nil
		}
		versions[name] = version
	}
	return func(root *os.Root) bool { return checkJSMetadataVersions(root, versions) }
}

func validJSMetadata(data []byte, name, expectedVersion string) bool {
	if len(data) > pythonManifestLimit {
		return false
	}
	decoded, valid := decodeCheckJSON(data)
	manifest, object := decoded.(map[string]any)
	if !valid || !object || !validJSMetadataOptions(manifest, expectedVersion) {
		return false
	}
	description, text := manifest["description"].(string)
	if !text || !strings.Contains(description, "LogBrew") {
		return false
	}
	policy := newJSMetadataPolicy(name)
	for path, expected := range policy.fields {
		value, exists := checkField(manifest, strings.Split(path, "."))
		if !exists || !reflect.DeepEqual(value, expected) {
			return false
		}
	}
	return policy.validExports(manifest) && policy.validFiles(manifest[jsMetadataFiles])
}

func validJSMetadataOptions(manifest map[string]any, expected string) bool {
	if private, present := manifest["private"]; present {
		flag, boolean := private.(bool)
		if !boolean || flag {
			return false
		}
	}
	if module, present := manifest["module"]; present && module != nil && module != jsMetadataIndex {
		return false
	}
	version, text := manifest[pythonManifestVersion].(string)
	return text && validPythonPackageVersion(version) && (expected == "" || expected == version)
}

func (policy *jsMetadataPolicy) validExports(manifest map[string]any) bool {
	for name, fields := range policy.exports {
		exported, exists := checkField(manifest, []string{jsMetadataExport, name})
		object, valid := exported.(map[string]any)
		if !exists || !valid {
			return false
		}
		for field, expected := range fields {
			actual, present := checkField(object, strings.Split(field, "."))
			if !present || actual != expected {
				return false
			}
		}
	}
	return true
}

func (policy *jsMetadataPolicy) validFiles(value any) bool {
	files, array := value.([]any)
	if !array {
		return false
	}
	present := make(map[string]bool, len(files))
	for _, file := range files {
		name, text := file.(string)
		if !text || name == "" || present[name] {
			return false
		}
		present[name] = true
	}
	for _, required := range policy.files {
		if !present[required] {
			return false
		}
	}
	return true
}
