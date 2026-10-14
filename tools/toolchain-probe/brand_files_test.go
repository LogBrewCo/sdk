package main

import (
	"os"
	"testing"
)

func TestBrandManifestRepositoryFiles(t *testing.T) {
	t.Parallel()
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("manifest rejected")
	}
	root, err := os.OpenRoot("../..")
	if err != nil {
		t.Fatal("brand repository root unavailable")
	}
	defer func() {
		if closeError := root.Close(); closeError != nil {
			t.Error("brand repository root close failed")
		}
	}()
	if !brandDirectoryInventory(root, manifest.assets, markdownFileLimit) ||
		!brandManifestFiles(root, &manifest, markdownByteLimit) {
		t.Fatal("actual brand files rejected")
	}
	if brandManifestFiles(root, &manifest, 1) {
		t.Fatal("aggregate byte limit ignored")
	}
	manifest.legacy[manifest.assets[0].digest] = true
	if brandManifestFiles(root, &manifest, markdownByteLimit) {
		t.Fatal("legacy artwork accepted")
	}
}
