package main

import (
	"context"
	"encoding/json"
	"io"
	"path/filepath"
)

const (
	pythonPublicVerifyMode  = "verify-public"
	pythonPublicResolveMode = "resolve-public"
)

func runPythonPublicVerify(arguments []string, output, diagnostic io.Writer) int {
	resolve := len(arguments) > 0 && arguments[0] == pythonPublicResolveMode
	expected := 3
	if resolve {
		expected++
	}
	if len(arguments) != expected || !filepath.IsAbs(arguments[1]) || !filepath.IsAbs(arguments[2]) ||
		resolve && (!filepath.IsAbs(arguments[3]) || filepath.Clean(arguments[3]) != arguments[3]) {
		return writeText(diagnostic,
			"public verification requires absolute artifact/manifest paths and resolve-public adds a new bundle path\n",
			exitUsage)
	}
	data, readable := readCheckFile(arguments[2])
	if !readable {
		return writeText(diagnostic, "Python release manifest cannot be read\n", exitFailure)
	}
	client := newPythonRegistryClient()
	if client == nil {
		return writeText(diagnostic, "Python registry client unavailable\n", exitFailure)
	}
	defer client.CloseIdleConnections()
	bundle, valid := preparePythonPublicBundle(context.Background(), client, arguments[1], data)
	if !valid {
		return writeText(diagnostic, "Python public artifact verification failed: "+bundle.failure+"\n", exitFailure)
	}
	if resolve && !writePythonPublicBundle(arguments[3], bundle) {
		return writeText(diagnostic,
			"Python public bundle write, readback, or exclusive publication failed\n", exitFailure)
	}
	if err := json.NewEncoder(output).Encode(bundle.reconciliation); err != nil {
		return exitFailure
	}
	return exitOK
}
