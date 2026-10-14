package main

import (
	"bytes"
	"context"
	"os"
	"testing"
)

func TestBrandPreparedRepositoryOutputs(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("prepared output integration requires native renderer enablement")
	}
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("output manifest rejected")
	}
	outputs, valid := brandGeneratedOutputs(context.Background(),
		[]byte(repositorySource(t, brandCanonicalSource)), manifest.assets)
	const generatedCount = 12
	if !valid || len(outputs) != generatedCount {
		t.Fatal("complete generated output set missing")
	}
	for _, asset := range manifest.assets {
		data, generated := outputs[asset.name]
		if asset.generation != brandSVGDerivative && asset.generation != brandRasterGeneration {
			if generated {
				t.Fatal("guarded or canonical asset included in generated writes")
			}
			continue
		}
		actual := []byte(repositorySource(t, asset.name))
		if !generated || !brandPreparedOutputEqual(&asset, actual, data) {
			t.Fatal("prepared output differs from repository artwork")
		}
	}
}

func brandPreparedOutputEqual(asset *brandAssetIdentity, actual, expected []byte) bool {
	if asset.kind == brandSVGKind {
		return bytes.Equal(actual, expected)
	}
	return brandPNGPixelEqual(actual, expected)
}

func TestBrandOutputPreparationFailure(t *testing.T) {
	t.Parallel()
	asset := brandAssetIdentity{
		name: "assets/brand/prepared.svg", digest: "", kind: brandSVGKind,
		presentation: brandTransparentPresentation, generation: brandSVGDerivative, width: 1, height: 1,
	}
	outputs, valid := brandGeneratedOutputs(context.Background(), nil, []brandAssetIdentity{asset})
	if valid || outputs != nil {
		t.Fatal("failed generation exposed partial outputs")
	}
}

func TestBrandOutputPreparationCancelled(t *testing.T) {
	t.Parallel()
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("preparation manifest rejected")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	outputs, valid := brandGeneratedOutputs(ctx, []byte(repositorySource(t, brandCanonicalSource)), manifest.assets)
	if valid || outputs != nil {
		t.Fatal("cancelled generation exposed outputs")
	}
}
