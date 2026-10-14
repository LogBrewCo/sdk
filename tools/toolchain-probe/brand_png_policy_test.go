package main

import "testing"

func brandPNGPolicyFixture(header []byte) []byte {
	data := append([]byte("\x89PNG\r\n\x1a\n"), brandPNGChunk("IHDR", header)...)
	data = append(data, brandPNGChunk("IDAT", []byte{1})...)
	return append(data, brandPNGChunk("IEND", nil)...)
}

func TestBrandPNGPolicyFailures(t *testing.T) {
	t.Parallel()
	const heightByte, unsupportedDepth = 7, 16
	header := []byte{0, 0, 0, 1, 0, 0, 0, 1, 8, brandPNGRGB, 0, 0, 0}
	if !brandPNGContract(brandPNGPolicyFixture(header), 1, 1, "png_rgb") {
		t.Fatal("PNG policy fixture rejected")
	}
	for _, mutation := range []struct {
		name   string
		offset int
		value  byte
	}{
		{"zero width", 3, 0},
		{"zero height", heightByte, 0},
		{"depth", 8, unsupportedDepth},
		{"alpha", 9, brandPNGRGBA},
		{"compression", 10, 1},
		{"filter", brandPNGFilterOffset, 1},
		{"interlace", brandPNGEnvelope, 1},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			t.Parallel()
			changed := append([]byte(nil), header...)
			changed[mutation.offset] = mutation.value
			data := brandPNGPolicyFixture(changed)
			if _, valid := brandPNGMetadata(data); !valid {
				t.Fatal("policy mutation did not preserve valid chunk checksums")
			}
			if brandPNGContract(data, 1, 1, "png_rgb") {
				t.Fatal("PNG format policy drift accepted")
			}
		})
	}
	if brandPNGContract(brandPNGPolicyFixture(header), 0, 1, "png_rgb") ||
		brandPNGContract(brandPNGPolicyFixture(header), 1, 0, "png_rgb") {
		t.Fatal("zero expected dimension accepted")
	}
}
