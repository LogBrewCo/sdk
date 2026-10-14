package main

import "testing"

func TestBrandPNGNormalizedPixels(t *testing.T) {
	t.Parallel()
	const dimension = 128
	for _, name := range []string{"logbrew-logo-espresso-bg-128.png", "logbrew-logo-transparent-128.png"} {
		pixels, valid := brandPNGNormalizedPixels([]byte(repositorySource(t, "assets/brand/"+name)))
		if !valid || pixels.Bounds().Dx() != dimension || pixels.Bounds().Dy() != dimension ||
			len(pixels.Pix) != dimension*dimension*4 {
			t.Fatal("PNG normalization contract changed")
		}
	}
	if _, valid := brandPNGNormalizedPixels(nil); valid {
		t.Fatal("invalid PNG pixels accepted")
	}
}
