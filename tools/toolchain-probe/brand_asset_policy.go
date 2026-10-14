package main

import "path"

const (
	brandSVGKind  = "svg"
	brandRGBKind  = "png_rgb"
	brandRGBAKind = "png_rgba"
)

func brandAssetPolicy(asset *brandAssetIdentity) bool {
	switch asset.kind {
	case brandSVGKind:
		if path.Ext(asset.name) != brandSVGExtension || asset.width != asset.height {
			return false
		}
	case brandRGBKind, brandRGBAKind:
		if path.Ext(asset.name) != brandPNGExtension {
			return false
		}
	default:
		return false
	}
	switch asset.generation {
	case "canonical_source", "svg_derivative":
		return asset.kind == brandSVGKind && brandAssetLogoPresentation(asset)
	case "rsvg":
		return asset.kind != brandSVGKind && asset.width == asset.height && brandAssetLogoPresentation(asset)
	case "guarded_composition":
		return asset.kind == brandRGBKind && asset.presentation == "sdk_social_card"
	default:
		return false
	}
}

func brandAssetLogoPresentation(asset *brandAssetIdentity) bool {
	switch asset.presentation {
	case brandEspressoPresentation:
		return asset.kind == brandSVGKind || asset.kind == brandRGBKind
	case brandTransparentPresentation:
		return asset.kind == brandSVGKind || asset.kind == brandRGBAKind
	default:
		return false
	}
}
