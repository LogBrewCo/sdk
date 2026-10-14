package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"maps"
	"net/http"
	"os"
	"path"
)

type pythonPublicBundle struct {
	artifacts                map[string][]byte
	manifest, reconciliation map[string]any
	failure                  string
}

type pythonPublicPackage struct {
	artifacts map[string][]byte
	receipt   map[string]any
	failure   string
}

func preparePythonPublicBundle(
	ctx context.Context, client *http.Client, directory string, data []byte,
) (pythonPublicBundle, bool) {
	ctx, cancel := context.WithTimeout(ctx, pythonRegistryTimeout)
	defer cancel()
	document, readable := readPythonManifestDocument(data)
	selection, valid := pythonManifestIdentity(document)
	manifest, object := document.(map[string]any)
	if !readable || !valid || !object || !verifyPythonReleaseManifest(directory, data) || ctx.Err() != nil {
		return failedPythonPublicBundle("build_manifest_invalid"), false
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return failedPythonPublicBundle("build_directory_unreadable"), false
	}
	bundle, valid := preparePythonPublicAtRoot(ctx, client, root, selection, manifest)
	closeError := root.Close()
	if !valid {
		return bundle, false
	}
	if closeError != nil || !verifyPythonReleaseManifest(directory, data) || ctx.Err() != nil {
		return failedPythonPublicBundle("build_changed_or_expired"), false
	}
	return bundle, true
}

func preparePythonPublicAtRoot(
	ctx context.Context, client *http.Client, root *os.Root, selection pythonReleaseSelection, manifest map[string]any,
) (pythonPublicBundle, bool) {
	expected, valid := manifest[pythonManifestPackages].([]any)
	if !valid || len(expected) != len(pythonReleaseCatalog()) {
		return pythonPublicBundle{}, false
	}
	bundle := pythonPublicBundle{
		artifacts: make(map[string][]byte), manifest: nil, reconciliation: nil, failure: "",
	}
	packages := make([]any, 0, len(pythonReleaseCatalog()))
	receipts := make([]any, 0, len(pythonReleaseCatalog()))
	for index, spec := range pythonReleaseCatalog() {
		buildEntry, object := expected[index].(map[string]any)
		if !object {
			return pythonPublicBundle{}, false
		}
		downloaded, valid := readPythonPublicPackage(
			ctx, client, root, spec, selection.versions[spec.id], buildEntry,
		)
		if !valid {
			return failedPythonPublicBundle(spec.id + ": " + downloaded.failure), false
		}
		maps.Copy(bundle.artifacts, downloaded.artifacts)
		entry := map[string]any{"id": spec.id, pythonManifestVersion: selection.versions[spec.id]}
		for _, kind := range []string{pythonWheel, pythonSdist} {
			artifact, correct := downloaded.receipt[kind].(map[string]string)
			if !correct {
				return pythonPublicBundle{}, false
			}
			entry[kind] = map[string]any{
				pythonManifestFile: artifact[pythonManifestFile], pythonManifestHash: artifact[pythonManifestHash],
			}
		}
		packages = append(packages, entry)
		receipts = append(receipts, downloaded.receipt)
	}
	bundle.manifest = map[string]any{
		pythonManifestSchemaKey: json.Number("1"), pythonManifestCommitKey: selection.sourceCommit,
		pythonManifestPackages: packages,
	}
	bundle.reconciliation = map[string]any{
		pythonManifestSchemaKey: json.Number("1"), pythonManifestCommitKey: selection.sourceCommit,
		pythonManifestPackages: receipts,
	}
	return bundle, true
}

func readPythonPublicPackage(
	ctx context.Context, client *http.Client, root *os.Root,
	spec pythonReleaseSpec, version string, expected map[string]any,
) (pythonPublicPackage, bool) {
	metadata, valid := fetchPythonPublicMetadata(ctx, client, spec, version)
	if !valid {
		return failedPythonPublicPackage("registry_metadata_invalid_or_unavailable"), false
	}
	result := pythonPublicPackage{
		artifacts: make(map[string][]byte, pythonReleaseFileCount),
		receipt:   map[string]any{"id": spec.id, pythonManifestVersion: version},
		failure:   "",
	}
	for _, kind := range []string{pythonWheel, pythonSdist} {
		relative := pythonReleaseArtifactPath(spec, version, kind)
		input, err := openRootCheckInput(root, relative)
		if err != nil {
			return failedPythonPublicPackage(kind + ": build_unreadable"), false
		}
		built, readable := readCheckInputFile(input)
		digest := sha256.Sum256(built)
		artifact, object := expected[kind].(map[string]any)
		if !readable || !object || hex.EncodeToString(digest[:]) != artifact[pythonManifestHash] {
			return failedPythonPublicPackage(kind + ": build_changed"), false
		}
		public, downloaded := downloadPythonPublicArtifact(ctx, client, metadata[kind], path.Base(relative))
		receipt, correct := reconcilePythonPublicArtifact(built, public, metadata[kind], spec, version, kind)
		if !downloaded {
			return failedPythonPublicPackage(kind + ": download_unverified"), false
		}
		if !correct {
			return failedPythonPublicPackage(kind + ": content_or_identity_mismatch"), false
		}
		result.artifacts[relative], result.receipt[kind] = public, receipt
	}
	return result, true
}

func failedPythonPublicBundle(reason string) pythonPublicBundle {
	return pythonPublicBundle{artifacts: nil, manifest: nil, reconciliation: nil, failure: reason}
}

func failedPythonPublicPackage(reason string) pythonPublicPackage {
	return pythonPublicPackage{artifacts: nil, receipt: nil, failure: reason}
}
