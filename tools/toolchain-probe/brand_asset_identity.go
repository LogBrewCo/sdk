package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path"
	"strconv"
	"strings"
)

type brandAssetIdentity struct {
	name, digest, kind, presentation, generation string
	width, height                                uint32
}

const brandDimensionBits = 32

func brandAssetString(object map[string]any, key string) string {
	value, ok := object[key].(string)
	if !ok {
		return ""
	}
	return value
}

func brandDigestValid(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && strings.ToLower(value) == value
}

func brandDimension(value any) (uint32, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.ParseUint(string(number), 10, brandDimensionBits)
	return uint32(parsed), err == nil && parsed != 0
}

func brandAssetDecode(value any) (brandAssetIdentity, bool) {
	var asset brandAssetIdentity
	object, ok := value.(map[string]any)
	if !ok {
		return asset, false
	}
	asset.name = brandAssetString(object, "path")
	asset.digest = brandAssetString(object, "sha256")
	asset.kind = brandAssetString(object, "kind")
	asset.presentation = brandAssetString(object, "presentation")
	asset.generation = brandAssetString(object, "generation")
	var widthOK, heightOK bool
	asset.width, widthOK = brandDimension(object["width"])
	asset.height, heightOK = brandDimension(object["height"])
	return asset, widthOK && heightOK && brandDigestValid(asset.digest) &&
		path.Dir(asset.name) == brandAssetDirectory && path.Clean(asset.name) == asset.name &&
		!strings.Contains(asset.name, "\\") && asset.kind != "" && asset.presentation != "" && asset.generation != ""
}
