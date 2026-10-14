package main

import (
	"context"
	"os"
	"testing"
)

func TestBrandRenderRepositoryPixels(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("native renderer integration requires explicit enablement")
	}
	master := []byte(repositorySource(t, brandCanonicalSource))
	svg, valid := brandDeriveSVG(master, "transparent", brandPixelDimensionLimit)
	if !valid {
		t.Fatal("renderer source derivation failed")
	}
	const size = 128
	rendered, valid := brandRenderPNG(context.Background(), svg, size)
	actual := []byte(repositorySource(t, "assets/brand/logbrew-logo-transparent-128.png"))
	if !valid || !brandPNGPixelEqual(actual, rendered) {
		t.Fatal("native rendered pixels differ from repository artwork")
	}
}

func TestBrandRasterRepositoryReproduction(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("native raster reproduction requires explicit enablement")
	}
	manifest, valid := brandManifestDecode([]byte(repositorySource(t, "assets/brand/manifest.json")))
	if !valid {
		t.Fatal("raster manifest rejected")
	}
	root, err := os.OpenRoot("../..")
	if err != nil {
		t.Fatal(err)
	}
	passed := brandRasterReproduction(context.Background(), root, manifest.assets)
	if err := root.Close(); err != nil || !passed {
		t.Fatal("native raster reproduction failed")
	}
}

func TestBrandRenderInvalidInput(t *testing.T) {
	t.Parallel()
	for _, size := range []uint32{0, brandPixelDimensionLimit + 1} {
		if data, valid := brandRenderPNG(context.Background(), nil, size); valid || data != nil {
			t.Fatal("invalid renderer size accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if data, valid := brandRenderPNG(ctx, nil, 1); valid || data != nil {
		t.Fatal("cancelled renderer succeeded")
	}
}
