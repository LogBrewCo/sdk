package main

const brandCanonicalSource = "assets/brand/logbrew-logo-espresso-bg-1600.svg"

type brandManifest struct {
	legacy   map[string]bool
	geometry string
	assets   []brandAssetIdentity
	copies   [][2]string
}

func brandManifestDecode(data []byte) (brandManifest, bool) {
	manifest := brandManifest{legacy: nil, geometry: "", assets: nil, copies: nil}
	decoded, valid := decodeCheckDocument(data)
	if !valid {
		return manifest, false
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return manifest, false
	}
	version, valid := brandDimension(object["schemaVersion"])
	manifest.geometry = brandAssetString(object, "canonicalGeometrySha256")
	if !valid || version != 1 || brandAssetString(object, "canonicalSource") != brandCanonicalSource ||
		!brandDigestValid(manifest.geometry) {
		return manifest, false
	}
	manifest, valid = brandManifestAssets(object["assets"], manifest)
	if !valid {
		return manifest, false
	}
	manifest.copies, valid = brandCopyPairs(object["exactCopies"])
	if !valid {
		return manifest, false
	}
	manifest.legacy, valid = brandLegacyHashes(object["legacySha256"])
	return manifest, valid && brandManifestCopyInventory(&manifest) && brandGenerationInventory(manifest.assets)
}

func brandManifestCopyInventory(manifest *brandManifest) bool {
	names := make(map[string]bool, len(manifest.assets))
	for _, asset := range manifest.assets {
		names[asset.name] = true
	}
	seen := make(map[[2]string]bool, len(manifest.copies))
	for _, pair := range manifest.copies {
		if !names[pair[0]] || !names[pair[1]] || seen[pair] {
			return false
		}
		seen[pair] = true
	}
	return true
}

func brandManifestAssets(value any, manifest brandManifest) (brandManifest, bool) {
	values, ok := value.([]any)
	if !ok || len(values) == 0 {
		return manifest, false
	}
	seen := make(map[string]bool, len(values))
	canonical := 0
	for _, value := range values {
		asset, valid := brandAssetDecode(value)
		if !valid || !brandAssetPolicy(&asset) || seen[asset.name] {
			return manifest, false
		}
		seen[asset.name] = true
		if asset.generation == "canonical_source" {
			if asset.name != brandCanonicalSource || asset.kind != brandSVGKind {
				return manifest, false
			}
			canonical++
		}
		manifest.assets = append(manifest.assets, asset)
	}
	return manifest, canonical == 1
}
