package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
)

const generatedArtifactMode = "generated-artifacts"

func runGeneratedArtifacts(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 || !filepath.IsAbs(arguments[0]) {
		return writeText(diagnostic, "generated-artifacts requires an absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[0])
	if err != nil {
		return writeText(diagnostic, "Generated artifact repository unavailable\n", exitFailure)
	}
	result := generatedArtifacts(root, generatedEntryLimit)
	if root.Close() != nil {
		result.complete = false
	}
	return writeGeneratedArtifacts(output, result)
}

func writeGeneratedArtifacts(output io.Writer, result generatedInventory) int {
	passed := result.complete && len(result.paths) == 0
	if result.paths == nil {
		result.paths = []string{}
	}
	receipt := struct {
		Artifacts []string `json:"artifacts"`
		Complete  bool     `json:"complete"`
		Passed    bool     `json:"passed"`
	}{Artifacts: result.paths, Complete: result.complete, Passed: passed}
	if err := json.NewEncoder(output).Encode(receipt); err != nil || !passed {
		return exitFailure
	}
	return exitOK
}
