package main

import (
	"encoding/json"
	"os"
	"strings"
)

const (
	nugetPublicManifestName     = "nuget-public-reconciliation.json"
	nugetPublicPackageDirectory = "packages"
)

type nugetResolvedPackage struct {
	spec     *nugetArtifactSpec
	artifact *nugetPublicArtifact
}

// Keep the two artifacts and their receipt in one exclusively published
// directory. An external receipt path cannot provide the same atomic boundary.
func writeNugetPublicBundle(destination string, packages []nugetResolvedPackage) bool {
	files, valid := nugetPublicOutputFiles(packages)
	return valid && writeReleaseBundle(destination, func(root *os.Root) bool {
		if err := root.Mkdir(nugetPublicPackageDirectory, pythonBundleDirectoryMode); err != nil {
			return false
		}
		for name, data := range files {
			if !createVerifiedReleaseOutput(root, name, data, pythonTemporaryFileMode) {
				return false
			}
		}
		return syncPythonDirectory(root, nugetPublicPackageDirectory) && syncPythonDirectory(root, ".")
	})
}

func nugetPublicOutputFiles(packages []nugetResolvedPackage) (map[string][]byte, bool) {
	if !validNugetOutputSelection(packages) {
		return nil, false
	}
	files := make(map[string][]byte, len(packages)+1)
	records := make([]map[string]string, 0, len(packages))
	for _, item := range packages {
		artifact := item.artifact
		if artifact == nil {
			return nil, false
		}
		actual := item.spec.bindPublicArtifact(artifact.data, artifact.registrySHA512)
		if actual == nil || actual.sha256 != artifact.sha256 || actual.contentSHA256 != artifact.contentSHA256 {
			return nil, false
		}
		name := item.spec.id + "." + item.spec.version + ".nupkg"
		files[nugetPublicPackageDirectory+"/"+name] = artifact.data
		records = append(records, map[string]string{
			"id": item.spec.id, pythonManifestVersion: item.spec.version, pythonManifestFile: name,
			pythonManifestHash: artifact.sha256, "registrySha512": artifact.registrySHA512,
			pythonPublicContentHash: artifact.contentSHA256,
		})
	}
	manifest, err := json.Marshal(map[string]any{
		pythonManifestSchemaKey: 1, pythonManifestCommitKey: packages[0].spec.sourceCommit,
		pythonManifestPackages: records,
	})
	if err != nil || len(manifest) >= pythonManifestLimit {
		return nil, false
	}
	files[nugetPublicManifestName] = append(manifest, '\n')
	return files, true
}

func validNugetOutputSelection(packages []nugetResolvedPackage) bool {
	if len(packages) != 2 || !packages[0].spec.valid() || !packages[1].spec.valid() {
		return false
	}
	core, adapter := packages[0].spec, packages[1].spec
	coreRange := adapter.dependencies.dependencies[dotnetMetadataCore]
	return core.id == dotnetMetadataCore && adapter.id == dotnetMetadataHTTP &&
		core.sourceCommit == adapter.sourceCommit && nugetDependencyRange(coreRange) == coreRange &&
		strings.HasPrefix(coreRange, "["+core.version+", ")
}
