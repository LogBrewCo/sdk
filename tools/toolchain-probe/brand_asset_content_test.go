package main

import "testing"

func TestBrandAssetRepositoryContent(t *testing.T) {
	t.Parallel()
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("brand manifest rejected")
	}
	for _, asset := range manifest.assets {
		t.Run(asset.name, func(t *testing.T) {
			t.Parallel()
			data := []byte(repositorySource(t, asset.name))
			if !brandAssetContent(data, &asset, manifest.geometry) {
				t.Fatal("actual asset content differs from manifest")
			}
			changed := append(append([]byte(nil), data...), '\n')
			if brandAssetContent(changed, &asset, manifest.geometry) {
				t.Fatal("content digest drift accepted")
			}
		})
	}
}
