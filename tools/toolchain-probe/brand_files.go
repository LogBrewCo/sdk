package main

import (
	"bytes"
	"os"
)

func brandManifestFiles(root *os.Root, manifest *brandManifest, byteLimit int) bool {
	copyNames := make(map[string]bool)
	for _, pair := range manifest.copies {
		copyNames[pair[0]], copyNames[pair[1]] = true, true
	}
	contents := make(map[string][]byte, len(copyNames))
	for _, asset := range manifest.assets {
		limit := min(byteLimit, brandSVGByteLimit)
		data, valid := brandReadAsset(root, asset.name, limit)
		if !valid || !brandAssetContent(data, &asset, manifest.geometry) || manifest.legacy[asset.digest] {
			return false
		}
		byteLimit -= len(data)
		if copyNames[asset.name] {
			contents[asset.name] = data
		}
	}
	for _, pair := range manifest.copies {
		source, sourceOK := contents[pair[0]]
		target, targetOK := contents[pair[1]]
		if !sourceOK || !targetOK || !bytes.Equal(source, target) {
			return false
		}
	}
	return true
}
