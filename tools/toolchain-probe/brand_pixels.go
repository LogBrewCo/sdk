package main

import (
	"bytes"
	"image"
	"image/draw"
	"image/png"
)

const brandPixelDimensionLimit = 1600

func brandPNGNormalizedPixels(data []byte) (*image.NRGBA, bool) {
	header, valid := brandPNGMetadata(data)
	if !valid || header.width == 0 || header.height == 0 ||
		header.width > brandPixelDimensionLimit || header.height > brandPixelDimensionLimit ||
		header.depth != 8 || header.color != brandPNGRGB && header.color != brandPNGRGBA {
		return nil, false
	}
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false
	}
	result := image.NewNRGBA(decoded.Bounds())
	draw.Draw(result, result.Bounds(), decoded, decoded.Bounds().Min, draw.Src)
	return result, true
}
