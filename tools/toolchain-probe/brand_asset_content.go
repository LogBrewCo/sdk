package main

import (
	"crypto/sha256"
	"encoding/hex"
)

func brandAssetContent(data []byte, asset *brandAssetIdentity, geometryDigest string) bool {
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != asset.digest {
		return false
	}
	if asset.kind != brandSVGKind {
		return brandPNGContract(data, asset.width, asset.height, asset.kind)
	}
	root, geometry := brandSVGParse(data)
	if geometry == nil || !brandSVGContract(root, asset.width, asset.presentation) {
		return false
	}
	actual, err := brandGeometryDigest(geometry)
	return err == nil && actual == geometryDigest
}
