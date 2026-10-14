package main

import "bytes"

func brandPNGPixelEqual(actual, expected []byte) bool {
	actualHeader, actualValid := brandPNGMetadata(actual)
	expectedHeader, expectedValid := brandPNGMetadata(expected)
	if !actualValid || !expectedValid || actualHeader != expectedHeader {
		return false
	}
	actualPixels, actualValid := brandPNGNormalizedPixels(actual)
	expectedPixels, expectedValid := brandPNGNormalizedPixels(expected)
	return actualValid && expectedValid && actualPixels.Bounds() == expectedPixels.Bounds() &&
		bytes.Equal(actualPixels.Pix, expectedPixels.Pix)
}
