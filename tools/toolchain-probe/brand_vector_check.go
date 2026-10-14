package main

import (
	"bytes"
	"os"
)

func brandVectorReproduction(root *os.Root, assets []brandAssetIdentity) bool {
	master, valid := brandReadAsset(root, brandCanonicalSource, brandSVGByteLimit)
	if !valid {
		return false
	}
	for _, asset := range assets {
		if asset.generation != brandSVGDerivative {
			continue
		}
		presentation := brandEspressoDerivation
		if asset.presentation == brandTransparentPresentation {
			presentation = brandTransparentDerivation
		}
		expected, derived := brandDeriveSVG(master, presentation, asset.width)
		actual, read := brandReadAsset(root, asset.name, brandSVGByteLimit)
		if !derived || !read || !bytes.Equal(actual, expected) {
			return false
		}
	}
	return true
}
