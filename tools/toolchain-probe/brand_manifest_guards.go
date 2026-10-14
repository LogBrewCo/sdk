package main

import (
	"path"
	"strings"
)

const brandAssetDirectory = "assets/brand"

func brandCopyPath(value any) (string, bool) {
	name, ok := value.(string)
	return name, ok && path.Dir(name) == brandAssetDirectory && path.Clean(name) == name &&
		!strings.Contains(name, "\\")
}

func brandCopyPairs(value any) ([][2]string, bool) {
	entries, ok := value.([]any)
	if !ok {
		return nil, false
	}
	pairs := make([][2]string, 0, len(entries))
	for _, entry := range entries {
		pair, valid := entry.([]any)
		if !valid || len(pair) != 2 {
			return nil, false
		}
		source, sourceOK := brandCopyPath(pair[0])
		target, targetOK := brandCopyPath(pair[1])
		if !sourceOK || !targetOK || source == target {
			return nil, false
		}
		pairs = append(pairs, [2]string{source, target})
	}
	return pairs, true
}

func brandLegacyHashes(value any) (map[string]bool, bool) {
	entries, ok := value.([]any)
	if !ok {
		return nil, false
	}
	hashes := make(map[string]bool, len(entries))
	for _, entry := range entries {
		digest, valid := entry.(string)
		if !valid || !brandDigestValid(digest) || hashes[digest] {
			return nil, false
		}
		hashes[digest] = true
	}
	return hashes, true
}
