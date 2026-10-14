package main

import (
	"context"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sync"
)

type pythonSmokeWheel struct {
	id, version, filename string
	receipt               pythonArchiveReceipt
}

func bindPythonSmokeWheels(
	ctx context.Context, options pythonSmokeOptions, directory string, client *http.Client, lookup func(string) string,
) ([]pythonSmokeWheel, bool) {
	files, supplied := pythonSmokeSuppliedFiles(options, lookup)
	manifest, valid := pythonSmokeManifest(options)
	if !supplied || !valid || os.Mkdir(directory, pythonBundleDirectoryMode) != nil {
		return nil, false
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, false
	}
	wheels, bound := bindPythonSmokeAtRoot(ctx, options, root, client, files, manifest)
	closeError := root.Close()
	return wheels, bound && closeError == nil
}

func pythonSmokeManifest(options pythonSmokeOptions) (map[string]any, bool) {
	if options.manifest == "" {
		return nil, true
	}
	data, readable := readCheckFile(options.manifest)
	document, parsed := readPythonManifestDocument(data)
	identity, valid := pythonManifestIdentity(document)
	root, object := document.(map[string]any)
	if !readable || !parsed || !valid || !object ||
		options.artifacts != "" && !verifyPythonReleaseManifest(options.artifacts, data) {
		return nil, false
	}
	for id, version := range options.versions {
		if identity.versions[id] != version {
			return nil, false
		}
	}
	return root, true
}

func pythonSmokeSuppliedFiles(options pythonSmokeOptions, lookup func(string) string) (map[string]string, bool) {
	if !options.receipt {
		return nil, true
	}
	value, parsed := readPythonManifestDocument([]byte(lookup("LOGBREW_RELEASE_ARTIFACT_FILES_JSON")))
	document, object := value.(map[string]any)
	catalog := pythonReleaseCatalog()
	if !parsed || !object || len(document) != len(catalog) {
		return nil, false
	}
	files := make(map[string]string)
	for _, spec := range catalog {
		filename, valid := document["pypi:"+spec.id].(string)
		if !valid || !filepath.IsAbs(filename) {
			return nil, false
		}
		files[spec.id] = filename
	}
	return files, true
}

func bindPythonSmokeAtRoot(
	ctx context.Context, options pythonSmokeOptions, root *os.Root, client *http.Client,
	files map[string]string, manifest map[string]any,
) ([]pythonSmokeWheel, bool) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	catalog := pythonReleaseCatalog()
	wheels := make([]pythonSmokeWheel, len(catalog))
	pending := make(chan int, len(catalog))
	for index := range catalog {
		pending <- index
	}
	close(pending)
	var work sync.WaitGroup
	for range pythonRegistryConnections {
		work.Go(func() {
			for index := range pending {
				spec := catalog[index]
				data, readable := readPythonSmokeWheel(ctx, client, options, spec, files, manifest, index)
				receipt, valid := inspectPythonArchive(data, pythonWheel, spec.id, options.versions[spec.id])
				filename := path.Base(pythonReleaseArtifactPath(spec, options.versions[spec.id], pythonWheel))
				if !readable || !valid || !pythonSmokeManifestDigest(manifest, index, pythonWheel, receipt.SHA256) ||
					!replacePythonOutput(root, filename, data, pythonTemporaryFileMode) {
					cancel()
					return
				}
				wheels[index] = pythonSmokeWheel{
					id: spec.id, version: options.versions[spec.id], filename: filename, receipt: receipt,
				}
			}
		})
	}
	work.Wait()
	if ctx.Err() != nil {
		return nil, false
	}
	return wheels, true
}

func readPythonSmokeWheel(
	ctx context.Context, client *http.Client, options pythonSmokeOptions, spec pythonReleaseSpec,
	files map[string]string, manifest map[string]any, index int,
) ([]byte, bool) {
	if ctx.Err() != nil {
		return nil, false
	}
	if options.receipt {
		return readPythonSmokeSupplied(files[spec.id])
	}
	if options.artifacts != "" {
		return readPythonSmokeSupplied(filepath.Join(options.artifacts,
			pythonReleaseArtifactPath(spec, options.versions[spec.id], pythonWheel)))
	}
	metadata, valid := fetchPythonPublicMetadata(ctx, client, spec, options.versions[spec.id])
	if !valid {
		return nil, false
	}
	var wheel []byte
	for _, kind := range []string{pythonWheel, pythonSdist} {
		filename := path.Base(pythonReleaseArtifactPath(spec, options.versions[spec.id], kind))
		data, downloaded := downloadPythonPublicArtifact(ctx, client, metadata[kind], filename)
		receipt, parsed := inspectPythonArchive(data, kind, spec.id, options.versions[spec.id])
		if !downloaded || !parsed || !pythonSmokeManifestDigest(manifest, index, kind, receipt.SHA256) {
			return nil, false
		}
		if kind == pythonWheel {
			wheel = data
		}
	}
	return wheel, true
}

func pythonSmokeManifestDigest(manifest map[string]any, index int, kind, digest string) bool {
	if manifest == nil {
		return true
	}
	packages, array := manifest[pythonManifestPackages].([]any)
	if !array || index < 0 || index >= len(packages) {
		return false
	}
	entry, object := packages[index].(map[string]any)
	artifact, hasArtifact := entry[kind].(map[string]any)
	return object && hasArtifact && artifact[pythonManifestHash] == digest
}

func readPythonSmokeSupplied(filename string) ([]byte, bool) {
	if !filepath.IsAbs(filename) {
		return nil, false
	}
	root, err := os.OpenRoot(filepath.Dir(filename))
	if err != nil {
		return nil, false
	}
	input, openError := openRootCheckInput(root, filepath.Base(filename))
	closeError := root.Close()
	if openError != nil {
		return nil, false
	}
	data, readable := readCheckInputFile(input)
	return data, readable && closeError == nil && len(data) <= pythonArtifactLimit
}
