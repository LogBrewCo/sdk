package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"time"
)

const brandExportMode = "brand-export"

func runBrandExport(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 2 || !filepath.IsAbs(arguments[0]) || !filepath.IsAbs(arguments[1]) {
		return writeText(diagnostic,
			"brand-export requires absolute repository and new output directories\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "brand export repository unavailable\n", exitFailure)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	outputs, valid := brandPrepareAtRoot(ctx, root)
	cancel()
	closeError := root.Close()
	if !valid || closeError != nil || !brandWriteOutputBundle(arguments[1], outputs) {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}

func brandPrepareAtRoot(ctx context.Context, root *os.Root) (map[string][]byte, bool) {
	data, valid := brandReadAsset(root, "assets/brand/manifest.json", pythonManifestLimit)
	if !valid {
		return nil, false
	}
	manifest, valid := brandManifestDecode(data)
	if !valid {
		return nil, false
	}
	master, valid := brandReadAsset(root, brandCanonicalSource, brandSVGByteLimit)
	if !valid {
		return nil, false
	}
	return brandGeneratedOutputs(ctx, master, manifest.assets)
}
