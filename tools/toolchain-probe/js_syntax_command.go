package main

import (
	"io"
	"os"
	"path/filepath"
)

const jsSyntaxMode = "js-syntax"

func runJSSyntax(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "js-syntax requires one absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "JavaScript source repository unavailable\n", exitFailure)
	}
	names, valid := jsSyntaxFiles(root)
	closeError := root.Close()
	if !valid || closeError != nil || !jsSyntaxProcess(arguments[0], names) {
		return writeText(output, "{\"passed\":false}\n", exitFailure)
	}
	return writeText(output, "{\"passed\":true}\n", exitOK)
}
