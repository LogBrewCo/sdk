package main

import "testing"

func TestBrandPNGRepositoryContracts(t *testing.T) {
	t.Parallel()
	const large, medium, small = 1600, 512, 128
	const rgb, rgba = "png_rgb", "png_rgba"
	const storeSize, socialWidth = 1024, 1280
	const iconSize, socialHeight = 256, 640
	for _, asset := range []struct {
		name, kind    string
		width, height uint32
	}{
		{"logbrew-logo-espresso-bg-1600.png", rgb, large, large},
		{"logbrew-logo-espresso-bg-512.png", rgb, medium, medium},
		{"logbrew-logo-espresso-bg-128.png", rgb, small, small},
		{"logbrew-logo-transparent-1600.png", rgba, large, large},
		{"logbrew-logo-transparent-512.png", rgba, medium, medium},
		{"logbrew-logo-transparent-128.png", rgba, small, small},
		{"app-icon-256.png", rgb, iconSize, iconSize},
		{"app-store-icon-1024.png", rgb, storeSize, storeSize},
		{"google-play-icon-512.png", rgb, medium, medium},
		{"github-social-preview.png", rgb, socialWidth, socialHeight},
	} {
		t.Run(asset.name, func(t *testing.T) {
			t.Parallel()
			data := []byte(repositorySource(t, "assets/brand/"+asset.name))
			if !brandPNGContract(data, asset.width, asset.height, asset.kind) {
				t.Fatal("repository PNG contract drifted")
			}
			if brandPNGContract(data, asset.width+1, asset.height, asset.kind) ||
				brandPNGContract(data, asset.width, asset.height+1, asset.kind) ||
				brandPNGContract(data, asset.width, asset.height, "unsupported_png_kind") {
				t.Fatal("invalid PNG contract accepted")
			}
		})
	}
}
