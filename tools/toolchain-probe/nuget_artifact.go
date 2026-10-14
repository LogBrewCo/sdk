package main

import (
	"os"
	"path/filepath"
	"strings"
)

const nugetRepositoryType = "git"

type nugetArtifactSpec struct {
	dependencies              *nugetDependencyContract
	id, version, sourceCommit string
}

// Metadata binds this content to the selected source. Registry hash validation
// and installed consumer verification remain separate requirements.
func (spec *nugetArtifactSpec) contentSHA256(data []byte) (string, bool) {
	if !spec.valid() {
		return "", false
	}
	entries, valid := nugetArchiveEntries(data)
	if !valid || !spec.matchesMetadata(nugetNuspec(entries)) {
		return "", false
	}
	return nugetContentDigest(entries)
}

func (spec *nugetArtifactSpec) valid() bool {
	return spec != nil && spec.dependencies != nil && validPythonPackageVersion(spec.version) &&
		pythonLowerHex(spec.sourceCommit, pythonSourceCommitSize) &&
		(spec.id == dotnetMetadataCore || spec.id == dotnetMetadataHTTP)
}

func nugetNuspec(entries []pythonArchiveEntry) *metadataXMLNode {
	var document []byte
	for _, entry := range entries {
		if strings.HasSuffix(entry.name, ".nuspec") {
			if document != nil || entry.directory || len(entry.data) == 0 || len(entry.data) > nugetProjectLimit {
				return nil
			}
			document = entry.data
		}
	}
	root := parseMetadataXML(document)
	if root == nil || root.name != "package" || !root.hasNamespace(root.namespace) {
		return nil
	}
	return root.path("metadata")
}

func (spec *nugetArtifactSpec) matchesMetadata(metadata *metadataXMLNode) bool {
	if metadata == nil || metadata.value("id") != spec.id || metadata.value("version") != spec.version {
		return false
	}
	repository := metadata.path("repository")
	return repository != nil && repository.attribute("type") == nugetRepositoryType &&
		repository.attribute("url") == releaseMetadataRepository &&
		repository.attribute("commit") == spec.sourceCommit &&
		spec.dependencies.matchesNuspec(metadata)
}

func readNugetSourceDependencies(directory, packageID, coreRange string) *nugetDependencyContract {
	if !filepath.IsAbs(directory) || len(directory) > outputLimit ||
		(packageID != dotnetMetadataCore && packageID != dotnetMetadataHTTP) {
		return nil
	}
	before, err := os.Lstat(directory)
	if err != nil || !before.IsDir() {
		return nil
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil
	}
	after, statError := root.Stat(".")
	var contract *nugetDependencyContract
	if statError == nil && os.SameFile(before, after) {
		name := dotnetMetadataSource + packageID + "/" + packageID + dotnetMetadataProject
		data, readable := readNugetRootReceipt(root, name, nugetProjectLimit)
		if readable {
			contract = nugetSourceDependencies(data, packageID, coreRange)
		}
	}
	if closeError := root.Close(); closeError != nil {
		return nil
	}
	return contract
}
