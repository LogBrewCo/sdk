package main

import "testing"

func TestBrandAssetPolicies(t *testing.T) {
	t.Parallel()
	const pngName = "assets/brand/logo.png"
	asset := brandAssetIdentity{
		name: "assets/brand/logo.svg", digest: "", kind: "svg", presentation: brandEspressoPresentation,
		generation: "canonical_source", width: 1, height: 1,
	}
	if !brandAssetPolicy(&asset) {
		t.Fatal("valid SVG policy rejected")
	}
	for _, invalid := range []brandAssetIdentity{
		{
			name: pngName, digest: "", kind: brandSVGKind, presentation: asset.presentation,
			generation: asset.generation, width: 1, height: 1,
		},
		{
			name: asset.name, digest: "", kind: asset.kind, presentation: asset.presentation,
			generation: asset.generation, width: 1, height: 2,
		},
		{
			name: asset.name, digest: "", kind: asset.kind, presentation: asset.presentation,
			generation: "unsupported_generation", width: 1, height: 1,
		},
		{
			name: pngName, digest: "", kind: brandRGBAKind, presentation: brandEspressoPresentation,
			generation: "rsvg", width: 1, height: 1,
		},
		{
			name: pngName, digest: "", kind: brandRGBKind, presentation: brandTransparentPresentation,
			generation: "rsvg", width: 1, height: 1,
		},
	} {
		if brandAssetPolicy(&invalid) {
			t.Fatal("inconsistent asset policy accepted")
		}
	}
}
