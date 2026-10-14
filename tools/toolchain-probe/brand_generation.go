package main

const (
	brandSVGDerivative    = "svg_derivative"
	brandRasterGeneration = "rsvg"
)

func brandGeneratedAssets() map[string]string {
	return map[string]string{
		"assets/brand/logbrew-logo-espresso-bg-512.svg":  brandSVGDerivative,
		"assets/brand/logbrew-logo-transparent-1600.svg": brandSVGDerivative,
		"assets/brand/logbrew-logo-transparent-512.svg":  brandSVGDerivative,
		"assets/brand/app-icon-256.png":                  brandRasterGeneration,
		"assets/brand/app-store-icon-1024.png":           brandRasterGeneration,
		"assets/brand/google-play-icon-512.png":          brandRasterGeneration,
		"assets/brand/logbrew-logo-espresso-bg-128.png":  brandRasterGeneration,
		"assets/brand/logbrew-logo-espresso-bg-1600.png": brandRasterGeneration,
		"assets/brand/logbrew-logo-espresso-bg-512.png":  brandRasterGeneration,
		"assets/brand/logbrew-logo-transparent-128.png":  brandRasterGeneration,
		"assets/brand/logbrew-logo-transparent-1600.png": brandRasterGeneration,
		"assets/brand/logbrew-logo-transparent-512.png":  brandRasterGeneration,
	}
}

func brandGenerationInventory(assets []brandAssetIdentity) bool {
	generatedAssets := brandGeneratedAssets()
	seen := make(map[string]bool, len(generatedAssets))
	for _, asset := range assets {
		expected, generated := generatedAssets[asset.name]
		if generated {
			if asset.generation != expected || seen[asset.name] {
				return false
			}
			seen[asset.name] = true
		} else if asset.generation == brandSVGDerivative || asset.generation == brandRasterGeneration {
			return false
		}
	}
	return len(seen) == len(generatedAssets)
}
