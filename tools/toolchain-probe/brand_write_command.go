package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"time"
)

const brandWriteMode = "brand-write"

func runBrandWrite(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "brand-write requires one absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "brand write repository unavailable\n", exitFailure)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	outputs, valid := brandPrepareAtRoot(ctx, root)
	cancel()
	written := valid && brandWriteOutputs(root, outputs)
	closeError := root.Close()
	if !written || closeError != nil {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}
