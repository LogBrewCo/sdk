package main

import "context"

func brandOutputVector(master []byte, asset *brandAssetIdentity) ([]byte, bool) {
	presentation := brandEspressoDerivation
	if asset.presentation == brandTransparentPresentation {
		presentation = brandTransparentDerivation
	}
	return brandDeriveSVG(master, presentation, asset.width)
}

func brandGeneratedOutputs(ctx context.Context, master []byte, assets []brandAssetIdentity) (map[string][]byte, bool) {
	if !brandPreparationReady(ctx, assets) {
		return nil, false
	}
	outputs := make(map[string][]byte)
	raster := make(map[brandRasterKey][]byte)
	for _, asset := range assets {
		if ctx.Err() != nil || !brandAssetPolicy(&asset) {
			return nil, false
		}
		switch asset.generation {
		case brandSVGDerivative:
			data, valid := brandOutputVector(master, &asset)
			if !valid {
				return nil, false
			}
			outputs[asset.name] = data
		case brandRasterGeneration:
			key := brandRasterKey{presentation: asset.presentation, size: asset.width}
			data, valid := brandCachedRaster(ctx, master, key, raster)
			if !valid {
				return nil, false
			}
			outputs[asset.name] = data
		default:
		}
	}
	if ctx.Err() != nil || !brandOutputPolicy(outputs) {
		return nil, false
	}
	return outputs, true
}

func brandPreparationReady(ctx context.Context, assets []brandAssetIdentity) bool {
	return ctx.Err() == nil && brandGenerationInventory(assets)
}

func brandCachedRaster(ctx context.Context, master []byte, key brandRasterKey,
	raster map[brandRasterKey][]byte,
) ([]byte, bool) {
	if data, cached := raster[key]; cached {
		return data, true
	}
	data, valid := brandRasterExpected(ctx, master, key)
	if valid {
		raster[key] = data
	}
	return data, valid
}
