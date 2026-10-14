package main

import (
	"path"
	"slices"
)

const (
	pythonPublicState        = "publicationState"
	pythonPublicBuilt        = "source-build"
	pythonPublicExisting     = "existing"
	pythonPublicContentHash  = "contentSha256"
	pythonPublicRegistryHash = "registrySha256"
)

func reconcilePythonPublicArtifact(
	built, public []byte, registry pythonPublicArtifact, spec pythonReleaseSpec, version, kind string,
) (map[string]string, bool) {
	file := pythonReleaseArtifactPath(spec, version, kind)
	if !slices.Contains(pythonReleaseCatalog(), spec) || !validPythonPackageVersion(version) ||
		!slices.Contains([]string{pythonWheel, pythonSdist}, kind) ||
		!validPythonPublicURL(registry.url, path.Base(file)) {
		return nil, false
	}
	buildReceipt, builtValid := inspectPythonArchive(built, kind, spec.id, version)
	publicReceipt, publicValid := inspectPythonArchive(public, kind, spec.id, version)
	if !builtValid || !publicValid || publicReceipt.SHA256 != registry.sha256 ||
		buildReceipt.ContentSHA256 != publicReceipt.ContentSHA256 {
		return nil, false
	}
	state := pythonPublicExisting
	if buildReceipt.SHA256 == publicReceipt.SHA256 {
		state = pythonPublicBuilt
	}
	return map[string]string{
		pythonManifestFile: file, pythonManifestHash: publicReceipt.SHA256,
		pythonPublicRegistryHash: registry.sha256, pythonPublicContentHash: publicReceipt.ContentSHA256,
		pythonPublicState: state,
	}, true
}
