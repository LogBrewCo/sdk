package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"time"
)

const brandGeneratedMode = "brand-generated"

func runBrandGenerated(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "brand-generated requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "brand generation repository unavailable\n", exitFailure)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	passed := brandGeneratedCheck(ctx, root)
	cancel()
	if root.Close() != nil || !passed {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}

func brandGeneratedCheck(ctx context.Context, root *os.Root) bool {
	data, valid := brandReadAsset(root, "assets/brand/manifest.json", pythonManifestLimit)
	if !valid {
		return false
	}
	manifest, valid := brandManifestDecode(data)
	return valid && brandVectorReproduction(root, manifest.assets) &&
		brandRasterReproduction(ctx, root, manifest.assets)
}
