package main

const (
	brandPNGRGB  = 2
	brandPNGRGBA = 6
)

func brandPNGContract(data []byte, width, height uint32, kind string) bool {
	header, valid := brandPNGMetadata(data)
	if !valid || width == 0 || height == 0 || header.width != width || header.height != height ||
		header.depth != 8 || header.compression != 0 || header.filter != 0 || header.interlace != 0 {
		return false
	}
	switch kind {
	case brandRGBKind:
		return header.color == brandPNGRGB
	case brandRGBAKind:
		return header.color == brandPNGRGBA
	default:
		return false
	}
}
