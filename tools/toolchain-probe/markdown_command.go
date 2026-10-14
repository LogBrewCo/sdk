package main

import (
	"io"
	"os"
	"path/filepath"
)

const markdownCheckMode = "markdown-links"

func runMarkdownLinks(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "markdown-links requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "Markdown repository unavailable\n", exitFailure)
	}
	failure := markdownLinksFailure(root)
	if closeError := root.Close(); closeError != nil && failure.reason == "" {
		failure.reason = "repository-close-failed"
	}
	if failure.reason != "" {
		return writeMarkdownFailure(diagnostic, failure)
	}
	return writeText(output, "markdown links ok\n", exitOK)
}
