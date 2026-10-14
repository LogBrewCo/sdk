package main

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
)

const jsParserBootstrapMode = "js-parser-bootstrap"

func runJSParserBootstrap(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "js-parser-bootstrap requires one absolute new directory\n", exitUsage)
	}
	if filepath.Clean(arguments[0]) != arguments[0] {
		return writeText(diagnostic, "native parser destination must be normalized\n", exitUsage)
	}
	parent, err := os.OpenRoot(filepath.Dir(arguments[0]))
	if err != nil {
		return writeText(diagnostic, "native parser destination parent unavailable\n", exitFailure)
	}
	_, statError := parent.Lstat(filepath.Base(arguments[0]))
	closeError := parent.Close()
	if !errors.Is(statError, os.ErrNotExist) || closeError != nil {
		return writeText(diagnostic, "native parser destination already exists or is unavailable\n", exitFailure)
	}
	specification, supported := jsNativeArchiveForPlatform(runtime.GOOS + "/" + runtime.GOARCH)
	client := jsNativeDownloadClient()
	if !supported || client == nil {
		return writeText(diagnostic, "native parser download unavailable\n", exitFailure)
	}
	defer client.CloseIdleConnections()
	data, valid := jsNativeDownload(context.Background(), client, specification)
	if !valid || !jsNativeInstall(arguments[0], data, specification) {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}
