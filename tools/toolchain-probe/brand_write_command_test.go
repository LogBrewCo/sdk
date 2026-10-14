package main

import (
	"bytes"
	"io"
	"os"
	"testing"
)

func TestBrandWriteInvalidInputs(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{nil, {"brand-relative-root"}, {t.TempDir(), t.TempDir()}} {
		if runBrandWrite(arguments, io.Discard, io.Discard) != exitUsage {
			t.Fatal("brand write accepted invalid arguments")
		}
	}
	if runBrandWrite([]string{t.TempDir()}, io.Discard, io.Discard) != exitFailure {
		t.Fatal("brand write accepted incomplete repository")
	}
}

func TestBrandWriteDisposableRepository(t *testing.T) {
	t.Parallel()
	if os.Getenv("LOGBREW_TEST_BRAND_RENDERER") != "1" {
		t.Skip("write integration requires native renderer enablement")
	}
	const manifest = "assets/brand/manifest.json"
	master := repositorySource(t, brandCanonicalSource)
	root := openMarkdownFixture(t, map[string]string{
		manifest: repositorySource(t, manifest), brandCanonicalSource: master,
	})
	var output bytes.Buffer
	if runBrandWrite([]string{root.Name()}, &output, io.Discard) != exitOK ||
		output.String() != brandSuccessJSON() {
		t.Fatal("disposable native brand write failed")
	}
	actual, valid := brandReadAsset(root, brandCanonicalSource, brandSVGByteLimit)
	if !valid || string(actual) != master {
		t.Fatal("native write changed canonical source")
	}
	decoded, valid := brandManifestDecode([]byte(repositorySource(t, manifest)))
	if !valid || !brandVectorReproduction(root, decoded.assets) {
		t.Fatal("native write vector readback failed")
	}
	for name, expected := range brandWriterFixture(t) {
		actual, valid := brandReadAsset(root, name, brandSVGByteLimit)
		if !valid {
			t.Fatal("generated write readback unavailable")
		}
		if brandGeneratedAssets()[name] == brandRasterGeneration && !brandPNGPixelEqual(actual, expected) {
			t.Fatal("generated write raster pixels changed")
		}
	}
}
