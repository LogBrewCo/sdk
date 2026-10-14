package main

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
)

const jsParserInstallMode = "js-parser-install"

func runJSParserInstall(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 2 || !filepath.IsAbs(arguments[0]) || !filepath.IsAbs(arguments[1]) {
		return writeText(diagnostic, "js-parser-install requires an absolute archive and new directory\n", exitUsage)
	}
	specification, supported := jsNativeArchiveForPlatform(runtime.GOOS + "/" + runtime.GOARCH)
	if !supported {
		return writeText(diagnostic, "native parser platform unsupported\n", exitFailure)
	}
	root, err := os.OpenRoot(filepath.Dir(arguments[0]))
	if err != nil {
		return writeText(diagnostic, "native parser archive unavailable\n", exitFailure)
	}
	data, valid := jsNativeReadArchive(root, filepath.Base(arguments[0]))
	closeError := root.Close()
	if !valid || closeError != nil || !jsNativeInstall(arguments[1], data, specification) {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}
