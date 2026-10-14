package main

import (
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
)

func runPythonManifestCreate(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 4+len(pythonReleaseCatalog()) || !filepath.IsAbs(arguments[1]) ||
		!filepath.IsAbs(arguments[2]) || !strings.HasSuffix(arguments[2], ".json") {
		return writeText(diagnostic,
			"create-manifest requires absolute directory/output, source commit, and versions\n", exitUsage)
	}
	selection, valid := pythonReleaseVersions(arguments[3], arguments[4:])
	if !valid {
		return writeText(diagnostic, "invalid Python release selection\n", exitUsage)
	}
	document, valid := createPythonReleaseManifest(arguments[1], selection)
	if !valid {
		return writeText(diagnostic,
			"Python artifact inventory, digest, or metadata verification failed\n", exitFailure)
	}
	data, err := json.Marshal(document)
	if err != nil || !writePythonManifestFile(arguments[2], append(data, '\n')) {
		return writeText(diagnostic, "Python manifest write or readback failed\n", exitFailure)
	}
	return writeText(output, "{\"scope\":\"python_release_manifest_created\",\"valid\":true}\n", exitOK)
}

func runPythonManifestVerify(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 3 || !filepath.IsAbs(arguments[1]) || !filepath.IsAbs(arguments[2]) {
		return writeText(diagnostic,
			"verify-manifest requires absolute artifact directory and manifest paths\n", exitUsage)
	}
	data, readable := readCheckFile(arguments[2])
	if !readable || !verifyPythonReleaseManifest(arguments[1], data) {
		return writeText(diagnostic, "Python release artifact digest or metadata mismatch\n", exitFailure)
	}
	return writeText(output, "{\"scope\":\"python_release_manifest_verified\",\"valid\":true}\n", exitOK)
}

func runPythonManifestCheck(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 3+len(pythonReleaseCatalog()) || !filepath.IsAbs(arguments[1]) {
		return writeText(diagnostic,
			"check-manifest requires absolute manifest path, source commit, and versions\n", exitUsage)
	}
	selection, valid := pythonReleaseVersions(arguments[2], arguments[3:])
	if !valid {
		return writeText(diagnostic, "invalid Python release selection\n", exitUsage)
	}
	data, readable := readCheckFile(arguments[1])
	if !readable || !checkPythonReleaseManifest(data, selection) {
		return writeText(diagnostic, "Python release manifest identity mismatch\n", exitFailure)
	}
	return writeText(output, "{\"scope\":\"python_release_manifest_identity\",\"valid\":true}\n", exitOK)
}
