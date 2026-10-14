package main

import (
	"encoding/binary"
	"hash/crc32"
	"math"
	"testing"
)

func brandPNGChunk(kind string, payload []byte) []byte {
	length := len(payload)
	if length < 0 || length > math.MaxUint32 {
		panic("test PNG chunk exceeds format limit")
	}
	chunk := make([]byte, len(payload)+12)
	binary.BigEndian.PutUint32(chunk[:4], uint32(length))
	copy(chunk[4:8], kind)
	copy(chunk[8:], payload)
	binary.BigEndian.PutUint32(chunk[len(chunk)-4:], crc32.ChecksumIEEE(chunk[4:len(chunk)-4]))
	return chunk
}

func TestBrandPNGMetadata(t *testing.T) {
	t.Parallel()
	const (
		rgba           = 6
		width          = 512
		crcOffset      = 29
		headerEnd      = 33
		shortSignature = 7
		height         = 256
		truncatedChunk = 20
	)
	payload := []byte{0, 0, 2, 0, 0, 0, 1, 0, 8, rgba, 0, 0, 0}
	data := append([]byte("\x89PNG\r\n\x1a\n"), brandPNGChunk("IHDR", payload)...)
	data = append(data, brandPNGChunk("IDAT", []byte{1, 2})...)
	data = append(data, brandPNGChunk("IEND", nil)...)
	header, valid := brandPNGMetadata(data)
	if !valid || header.width != width || header.height != height || header.depth != 8 || header.color != rgba {
		t.Fatal("valid PNG header rejected")
	}
	corrupt := append([]byte(nil), data...)
	corrupt[crcOffset] ^= 1
	duplicate := append([]byte(nil), data[:headerEnd]...)
	duplicate = append(duplicate, data[8:]...)
	for _, rejected := range [][]byte{
		nil, data[:shortSignature], data[:truncatedChunk], data[:len(data)-1],
		append(append([]byte(nil), data...), 0), corrupt, duplicate, data[:headerEnd],
	} {
		if _, accepted := brandPNGMetadata(rejected); accepted {
			t.Fatal("malformed PNG accepted")
		}
	}
}
