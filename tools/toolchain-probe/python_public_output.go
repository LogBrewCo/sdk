package main

import (
	"encoding/json"
	"maps"
)

const (
	pythonPublicManifestName = "release-artifacts.json"
	pythonPublicReceiptName  = "public-reconciliation.json"
)

func pythonPublicOutputFiles(bundle pythonPublicBundle) (map[string][]byte, bool) {
	selection, valid := pythonManifestIdentity(bundle.manifest)
	if !valid || bundle.failure != "" || len(bundle.artifacts) != len(pythonReleaseCatalog())*pythonReleaseFileCount ||
		!validPythonPublicReceipts(bundle, selection) {
		return nil, false
	}
	files := maps.Clone(bundle.artifacts)
	for name, document := range map[string]map[string]any{
		pythonPublicManifestName: bundle.manifest, pythonPublicReceiptName: bundle.reconciliation,
	} {
		data, err := json.Marshal(document)
		if err != nil || len(data) >= pythonManifestLimit {
			return nil, false
		}
		files[name] = append(data, '\n')
	}
	return files, true
}

func validPythonPublicReceipts(bundle pythonPublicBundle, selection pythonReleaseSelection) bool {
	receipts, valid := bundle.reconciliation[pythonManifestPackages].([]any)
	if !valid || len(bundle.reconciliation) != 3 || len(receipts) != len(pythonReleaseCatalog()) ||
		bundle.reconciliation[pythonManifestCommitKey] != selection.sourceCommit ||
		bundle.reconciliation[pythonManifestSchemaKey] != json.Number("1") {
		return false
	}
	for index, spec := range pythonReleaseCatalog() {
		entry, object := receipts[index].(map[string]any)
		version := selection.versions[spec.id]
		if !object || len(entry) != 4 || entry["id"] != spec.id || entry[pythonManifestVersion] != version {
			return false
		}
		for _, kind := range []string{pythonWheel, pythonSdist} {
			if !validPythonPublicArtifactReceipt(entry[kind], bundle.artifacts, spec, version, kind) {
				return false
			}
		}
	}
	return true
}

func validPythonPublicArtifactReceipt(
	document any, artifacts map[string][]byte, spec pythonReleaseSpec, version, kind string,
) bool {
	name := pythonReleaseArtifactPath(spec, version, kind)
	receipt, parsed := document.(map[string]string)
	actual, valid := inspectPythonArchive(artifacts[name], kind, spec.id, version)
	return parsed && valid && len(receipt) == 5 && receipt[pythonManifestFile] == name &&
		receipt[pythonManifestHash] == actual.SHA256 && receipt[pythonPublicRegistryHash] == actual.SHA256 &&
		receipt[pythonPublicContentHash] == actual.ContentSHA256 &&
		(receipt[pythonPublicState] == pythonPublicBuilt || receipt[pythonPublicState] == pythonPublicExisting)
}
