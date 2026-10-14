package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

const brandMode = "brand-assets"

func runBrandAssets(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "brand-assets requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "brand repository unavailable\n", exitFailure)
	}
	passed := brandRepositoryCheck(root)
	if root.Close() != nil {
		passed = false
	}
	receipt := struct {
		Passed bool `json:"passed"`
	}{Passed: passed}
	if err := json.NewEncoder(output).Encode(receipt); err != nil || !passed {
		return exitFailure
	}
	return exitOK
}

func brandRepositoryCheck(root *os.Root) bool {
	data, valid := brandReadAsset(root, "assets/brand/manifest.json", pythonManifestLimit)
	if !valid {
		return false
	}
	manifest, valid := brandManifestDecode(data)
	return valid && brandDirectoryInventory(root, manifest.assets, markdownFileLimit) &&
		brandManifestFiles(root, &manifest, markdownByteLimit) && brandVectorReproduction(root, manifest.assets)
}
