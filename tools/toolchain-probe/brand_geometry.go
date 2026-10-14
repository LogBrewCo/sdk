package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"unicode/utf16"
	"unicode/utf8"
)

func brandGeometryJSON(geometry *brandSVGGeometry) ([]byte, error) {
	var encoded bytes.Buffer
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(map[string]any{
		"groups": geometry.Groups, "paths": geometry.Paths, "viewBox": geometry.ViewBox,
	}); err != nil {
		return nil, fmt.Errorf("encode brand geometry: %w", err)
	}
	return brandGeometryASCII(encoded.Bytes()), nil
}

func brandGeometryASCII(encoded []byte) []byte {
	result := make([]byte, 0, len(encoded))
	for _, value := range string(bytes.TrimSuffix(encoded, []byte{'\n'})) {
		if value < utf8.RuneSelf {
			result = append(result, string(value)...)
			continue
		}
		for _, unit := range utf16.Encode([]rune{value}) {
			result = fmt.Appendf(result, `\u%04x`, unit)
		}
	}
	return result
}

func brandGeometryDigest(geometry *brandSVGGeometry) (string, error) {
	encoded, err := brandGeometryJSON(geometry)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
