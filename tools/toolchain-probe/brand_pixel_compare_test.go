package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

func TestBrandPixelComparison(t *testing.T) {
	t.Parallel()
	actual := []byte(repositorySource(t, "assets/brand/logbrew-logo-transparent-128.png"))
	if !brandPNGPixelEqual(actual, actual) {
		t.Fatal("identical PNG pixels rejected")
	}
	pixels, valid := brandPNGNormalizedPixels(actual)
	if !valid {
		t.Fatal("actual pixel fixture rejected")
	}
	pixels.SetNRGBA(0, 0, color.NRGBA{R: 1, G: 2, B: 3, A: 255})
	var changed bytes.Buffer
	if err := png.Encode(&changed, pixels); err != nil {
		t.Fatal(err)
	}
	if brandPNGPixelEqual(actual, changed.Bytes()) {
		t.Fatal("changed pixels accepted")
	}
	var resized bytes.Buffer
	if err := png.Encode(&resized, image.NewNRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	if brandPNGPixelEqual(actual, resized.Bytes()) || brandPNGPixelEqual(nil, actual) {
		t.Fatal("invalid pixel comparison accepted")
	}
}
