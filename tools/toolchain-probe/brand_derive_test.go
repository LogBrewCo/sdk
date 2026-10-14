package main

import (
	"bytes"
	"testing"
)

func TestBrandSVGDerivation(t *testing.T) {
	t.Parallel()
	master := []byte(repositorySource(t, brandCanonicalSource))
	const small = 512
	for _, asset := range []struct {
		name, presentation string
		size               uint32
	}{
		{"logbrew-logo-espresso-bg-512.svg", "espresso-bg", small},
		{"logbrew-logo-transparent-512.svg", "transparent", small},
		{"logbrew-logo-transparent-1600.svg", "transparent", brandPixelDimensionLimit},
	} {
		derived, valid := brandDeriveSVG(master, asset.presentation, asset.size)
		if !valid || !bytes.Equal(derived, []byte(repositorySource(t, "assets/brand/"+asset.name))) {
			t.Fatal("SVG derivative differs from canonical transformation")
		}
	}
	if _, valid := brandDeriveSVG(master, "unsupported_presentation", small); valid {
		t.Fatal("unsupported SVG derivation accepted")
	}
}
