package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBrandDirectoryEscapingImage(t *testing.T) {
	t.Parallel()
	const name = "assets/brand/escape.png"
	root := openMarkdownFixture(t, map[string]string{"assets/brand/notes.txt": "directory fixture"})
	outside := filepath.Join(t.TempDir(), "outside.png")
	const fixtureMode = 0o600
	if err := os.WriteFile(outside, []byte("outside image fixture"), fixtureMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root.Name(), name)); err != nil {
		t.Fatal(err)
	}
	assets := []brandAssetIdentity{{
		name: name, digest: "", kind: brandRGBKind, presentation: "", generation: "", width: 1, height: 1,
	}}
	if brandDirectoryInventory(root, assets, markdownFileLimit) {
		t.Fatal("escaping image inventory accepted")
	}
	if _, valid := brandReadAsset(root, name, brandSVGByteLimit); valid {
		t.Fatal("escaping image content accepted")
	}
}

func TestBrandDirectoryInventory(t *testing.T) {
	t.Parallel()
	const name = "assets/brand/example.png"
	root := openMarkdownFixture(t, map[string]string{
		name: "image inventory fixture", "assets/brand/notes.txt": "ignored",
	})
	assets := []brandAssetIdentity{{
		name: name, digest: "", kind: brandRGBKind, presentation: "", generation: "", width: 1, height: 1,
	}}
	if !brandDirectoryInventory(root, assets, markdownFileLimit) {
		t.Fatal("exact image inventory rejected")
	}
	if brandDirectoryInventory(root, nil, markdownFileLimit) || brandDirectoryInventory(root, assets, 1) ||
		brandDirectoryInventory(root, assets, 0) {
		t.Fatal("unexpected or over-limit inventory accepted")
	}
	assets[0].name = "assets/brand/missing.png"
	if brandDirectoryInventory(root, assets, markdownFileLimit) {
		t.Fatal("missing image inventory accepted")
	}
}
