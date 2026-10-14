package main

import "testing"

func TestBrandGenerationInventory(t *testing.T) {
	t.Parallel()
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid || !brandGenerationInventory(manifest.assets) {
		t.Fatal("actual generation inventory rejected")
	}
	if brandGenerationInventory(nil) || brandGenerationInventory(manifest.assets[:1]) {
		t.Fatal("missing generated assets accepted")
	}
	changed := append([]brandAssetIdentity(nil), manifest.assets...)
	changed[1].generation = "guarded_composition"
	if brandGenerationInventory(changed) {
		t.Fatal("relabeled derivative accepted")
	}
	changed = append([]brandAssetIdentity(nil), manifest.assets...)
	changed[1].name = "assets/brand/unexpected.svg"
	if brandGenerationInventory(changed) {
		t.Fatal("unexpected derivative accepted")
	}
}
