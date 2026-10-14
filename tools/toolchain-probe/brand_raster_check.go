package main

import (
	"context"
	"os"
)

type brandRasterKey struct {
	presentation string
	size         uint32
}

func brandRasterExpected(ctx context.Context, master []byte, key brandRasterKey) ([]byte, bool) {
	presentation := brandEspressoDerivation
	if key.presentation == brandTransparentPresentation {
		presentation = brandTransparentDerivation
	}
	svg, valid := brandDeriveSVG(master, presentation, brandPixelDimensionLimit)
	if !valid {
		return nil, false
	}
	return brandRenderPNG(ctx, svg, key.size)
}

func brandRasterReproduction(ctx context.Context, root *os.Root, assets []brandAssetIdentity) bool {
	master, valid := brandReadAsset(root, brandCanonicalSource, brandSVGByteLimit)
	if !valid {
		return false
	}
	rendered := make(map[brandRasterKey][]byte)
	for _, asset := range assets {
		if asset.generation != brandRasterGeneration {
			continue
		}
		key := brandRasterKey{presentation: asset.presentation, size: asset.width}
		expected, cached := rendered[key]
		if !cached {
			expected, valid = brandRasterExpected(ctx, master, key)
			if !valid {
				return false
			}
			rendered[key] = expected
		}
		actual, read := brandReadAsset(root, asset.name, brandSVGByteLimit)
		if !read || !brandPNGPixelEqual(actual, expected) {
			return false
		}
	}
	return true
}
