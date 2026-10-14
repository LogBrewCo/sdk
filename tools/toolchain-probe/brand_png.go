package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"strconv"
)

const (
	brandPNGEnvelope     = 12
	brandPNGHeaderSize   = 13
	brandPNGCRCSize      = 4
	brandPNGFilterOffset = 11
	brandPNGPrefixSize   = 8
)

func brandPNGChunkEnd(data []byte, offset int) (int, bool) {
	if len(data)-offset < brandPNGEnvelope {
		return 0, false
	}
	length, err := strconv.Atoi(strconv.FormatUint(uint64(binary.BigEndian.Uint32(data[offset:offset+4])), 10))
	if err != nil || length > len(data)-offset-brandPNGEnvelope {
		return 0, false
	}
	end := offset + brandPNGPrefixSize + length
	return end, crc32.ChecksumIEEE(data[offset+4:end]) == binary.BigEndian.Uint32(data[end:end+brandPNGCRCSize])
}

type brandPNGHeader struct {
	width, height                                uint32
	depth, color, compression, filter, interlace byte
}

func brandPNGMetadata(data []byte) (brandPNGHeader, bool) {
	var header brandPNGHeader
	if !bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) {
		return header, false
	}
	seenHeader, seenData := false, false
	for offset := 8; offset < len(data); {
		end, valid := brandPNGChunkEnd(data, offset)
		if !valid {
			return header, false
		}
		kind := string(data[offset+4 : offset+8])
		switch kind {
		case "IHDR":
			if seenHeader || offset != 8 || end-offset-8 != brandPNGHeaderSize {
				return header, false
			}
			payload := data[offset+8 : end]
			header = brandPNGHeader{
				width: binary.BigEndian.Uint32(payload[:4]), height: binary.BigEndian.Uint32(payload[4:8]),
				depth: payload[8], color: payload[9], compression: payload[10],
				filter: payload[brandPNGFilterOffset], interlace: payload[brandPNGEnvelope],
			}
			seenHeader = true
		case "IDAT":
			seenData = true
		case "IEND":
			return header, seenHeader && seenData && end-offset == 8 && end+brandPNGCRCSize == len(data)
		default:
		}
		offset = end + brandPNGCRCSize
	}
	return header, false
}
