package main

import (
	"encoding/binary"
	"hash/crc32"
	"testing"
)

func TestBrandPixelsHeaderBounds(t *testing.T) {
	t.Parallel()
	header := []byte{0, 0, 0, 1, 0, 0, 0, 1, 8, brandPNGRGB, 0, 0, 0}
	const heightOffset = 4
	for _, offset := range []int{0, heightOffset} {
		changed := append([]byte(nil), header...)
		binary.BigEndian.PutUint32(changed[offset:offset+4], brandPixelDimensionLimit+1)
		if _, valid := brandPNGNormalizedPixels(brandPNGPolicyFixture(changed)); valid {
			t.Fatal("oversized pixel decode accepted")
		}
	}
	const depthOffset, colorOffset, unsupportedDepth = 8, 9, 16
	header[depthOffset] = unsupportedDepth
	if _, valid := brandPNGNormalizedPixels(brandPNGPolicyFixture(header)); valid {
		t.Fatal("unsupported pixel depth accepted")
	}
	header[depthOffset], header[colorOffset] = 8, 3
	if _, valid := brandPNGNormalizedPixels(brandPNGPolicyFixture(header)); valid {
		t.Fatal("unsupported pixel color type accepted")
	}
}

func TestBrandPixelsCorruptCompressedData(t *testing.T) {
	t.Parallel()
	const corruptMask = 0xff
	data := []byte(repositorySource(t, "assets/brand/logbrew-logo-transparent-128.png"))
	for offset := brandPNGPrefixSize; offset < len(data); {
		end, valid := brandPNGChunkEnd(data, offset)
		if !valid {
			t.Fatal("repository PNG chunk rejected")
		}
		if string(data[offset+4:offset+8]) == "IDAT" {
			data[offset+8] ^= corruptMask
			binary.BigEndian.PutUint32(data[end:end+4], crc32.ChecksumIEEE(data[offset+4:end]))
			if _, valid := brandPNGMetadata(data); !valid {
				t.Fatal("corrupt compression fixture lost valid checksums")
			}
			if _, valid := brandPNGNormalizedPixels(data); valid {
				t.Fatal("corrupt compressed pixels accepted")
			}
			return
		}
		offset = end + brandPNGCRCSize
	}
	t.Fatal("PNG compressed data fixture missing")
}
