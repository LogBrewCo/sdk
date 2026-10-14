package main

import (
	"encoding/json"
	"maps"
	"path"
	"reflect"
	"strings"
)

const (
	pythonManifestSchemaKey  = "schemaVersion"
	pythonManifestCommitKey  = "sourceCommit"
	pythonManifestLimit      = 2 << 20
	pythonSourceCommitSize   = 40
	pythonArtifactHashSize   = 64
	pythonManifestPackages   = "packages"
	pythonManifestVersion    = "version"
	pythonManifestFile       = "file"
	pythonReleaseFileCount   = 2
	pythonManifestHash       = "sha256"
	pythonManifestCreateMode = "create-manifest"
	pythonManifestVerifyMode = "verify-manifest"
	pythonManifestCheckMode  = "check-manifest"
	pythonCoreID             = "logbrew-sdk"
	pythonFastAPIID          = "logbrew-fastapi"
	pythonFlaskID            = "logbrew-flask"
	pythonDjangoID           = "logbrew-django"
)

type pythonReleaseSpec struct {
	id, directory string
}

type pythonReleaseSelection struct {
	versions     map[string]string
	sourceCommit string
}

func pythonReleaseCatalog() []pythonReleaseSpec {
	return []pythonReleaseSpec{
		{pythonCoreID, "logbrew_py"},
		{pythonFastAPIID, "logbrew_fastapi"},
		{pythonFlaskID, "logbrew_flask"},
		{pythonDjangoID, "logbrew_django"},
	}
}

func pythonReleaseVersions(commit string, versions []string) (pythonReleaseSelection, bool) {
	selection := pythonReleaseSelection{sourceCommit: commit, versions: make(map[string]string)}
	for _, raw := range versions {
		id, version, found := strings.Cut(raw, "=")
		id, version = strings.TrimSpace(id), strings.TrimSpace(version)
		if !found || selection.versions[id] != "" || !validPythonPackageVersion(version) {
			return pythonReleaseSelection{}, false
		}
		selection.versions[id] = version
	}
	return selection, validPythonReleaseSelection(selection)
}

func validPythonReleaseSelection(selection pythonReleaseSelection) bool {
	catalog := pythonReleaseCatalog()
	if !pythonLowerHex(selection.sourceCommit, pythonSourceCommitSize) || len(selection.versions) != len(catalog) {
		return false
	}
	for _, spec := range catalog {
		if !validPythonPackageVersion(selection.versions[spec.id]) {
			return false
		}
	}
	return true
}

func pythonLowerHex(value string, size int) bool {
	return len(value) == size && strings.Trim(value, "0123456789abcdef") == ""
}

func pythonReleaseArtifactPath(spec pythonReleaseSpec, version, kind string) string {
	suffix := ".tar.gz"
	if kind == pythonWheel {
		suffix = "-py3-none-any.whl"
	}
	return path.Join(spec.directory, pythonArtifactRoot(spec.id, version)+suffix)
}

func pythonManifestIdentity(document any) (pythonReleaseSelection, bool) {
	root, isObject := document.(map[string]any)
	commit, isString := root[pythonManifestCommitKey].(string)
	packages, isArray := root[pythonManifestPackages].([]any)
	catalog := pythonReleaseCatalog()
	if !isObject || len(root) != 3 || root[pythonManifestSchemaKey] != json.Number("1") ||
		!isString || !isArray || len(packages) != len(catalog) {
		return pythonReleaseSelection{}, false
	}
	selection := pythonReleaseSelection{sourceCommit: commit, versions: make(map[string]string)}
	for index, spec := range catalog {
		entry, valid := packages[index].(map[string]any)
		version, versionString := entry[pythonManifestVersion].(string)
		if !valid || len(entry) != 4 || entry["id"] != spec.id || !versionString ||
			!pythonManifestArtifacts(entry, spec, version) {
			return pythonReleaseSelection{}, false
		}
		selection.versions[spec.id] = version
	}
	return selection, validPythonReleaseSelection(selection)
}

func pythonManifestArtifacts(entry map[string]any, spec pythonReleaseSpec, version string) bool {
	for _, kind := range []string{pythonWheel, pythonSdist} {
		artifact, valid := entry[kind].(map[string]any)
		digest, isString := artifact[pythonManifestHash].(string)
		if !valid || len(artifact) != 2 || !isString || !pythonLowerHex(digest, pythonArtifactHashSize) ||
			artifact[pythonManifestFile] != pythonReleaseArtifactPath(spec, version, kind) {
			return false
		}
	}
	return true
}

func readPythonManifestDocument(data []byte) (any, bool) {
	if len(data) > pythonManifestLimit {
		return nil, false
	}
	return decodeCheckDocument(data)
}

func checkPythonReleaseManifest(data []byte, expected pythonReleaseSelection) bool {
	document, readable := readPythonManifestDocument(data)
	selection, valid := pythonManifestIdentity(document)
	return readable && valid && validPythonReleaseSelection(expected) &&
		selection.sourceCommit == expected.sourceCommit &&
		maps.Equal(selection.versions, expected.versions)
}

func verifyPythonReleaseManifest(directory string, data []byte) bool {
	document, readable := readPythonManifestDocument(data)
	selection, valid := pythonManifestIdentity(document)
	if !readable || !valid {
		return false
	}
	expected, valid := createPythonReleaseManifest(directory, selection)
	return valid && reflect.DeepEqual(document, expected)
}
