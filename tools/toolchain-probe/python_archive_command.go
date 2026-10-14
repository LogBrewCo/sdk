package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const pythonArchiveMode = "python-archive"

type pythonArchiveReceipt struct {
	Scope         string `json:"scope"`
	SHA256        string `json:"sha256"`
	ContentSHA256 string `json:"content_sha256"`
	Files         int    `json:"files"`
	Valid         bool   `json:"valid"`
}

func runPythonArchive(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) > 0 {
		switch arguments[0] {
		case pythonInstalledMode:
			return runPythonInstalled(arguments, output, diagnostic)
		case pythonNormalizeMode:
			return runPythonSdistNormalize(arguments, output, diagnostic)
		case pythonManifestCreateMode:
			return runPythonManifestCreate(arguments, output, diagnostic)
		case pythonManifestVerifyMode:
			return runPythonManifestVerify(arguments, output, diagnostic)
		case pythonManifestCheckMode:
			return runPythonManifestCheck(arguments, output, diagnostic)
		case pythonPublicVerifyMode, pythonPublicResolveMode:
			return runPythonPublicVerify(arguments, output, diagnostic)
		}
	}
	if !validPythonArchiveSelection(arguments) {
		return writeText(diagnostic,
			"python-archive requires kind, absolute artifact path, package ID, and version\n", exitUsage)
	}
	data, valid := readCheckFile(arguments[1])
	if !valid {
		return writeText(diagnostic, "Python package archive is unreadable or exceeds its limit\n", exitFailure)
	}
	receipt, valid := inspectPythonArchive(data, arguments[0], arguments[2], arguments[3])
	if !valid {
		return writeText(diagnostic, "Python package archive or identity is invalid\n", exitFailure)
	}
	if err := json.NewEncoder(output).Encode(receipt); err != nil {
		return exitFailure
	}
	return exitOK
}

func inspectPythonArchive(data []byte, kind, packageID, version string) (pythonArchiveReceipt, bool) {
	entries, valid := readPythonArchive(data, kind)
	if !valid || !pythonArchiveIdentity(entries, kind, pythonArtifactRoot(packageID, version), packageID, version) {
		return pythonArchiveReceipt{}, false
	}
	files := 0
	for _, entry := range entries {
		if !entry.directory {
			files++
		}
	}
	digest := sha256.Sum256(data)
	contentDigest := pythonArchiveDigest(entries)
	return pythonArchiveReceipt{
		Scope: "python_archive_identity", SHA256: hex.EncodeToString(digest[:]),
		ContentSHA256: contentDigest, Files: files, Valid: true,
	}, contentDigest != ""
}

func validPythonArchiveSelection(arguments []string) bool {
	if len(arguments) != 4 || !filepath.IsAbs(arguments[1]) ||
		!slices.Contains([]string{pythonWheel, pythonSdist}, arguments[0]) ||
		!slices.ContainsFunc(pythonReleaseCatalog(), func(spec pythonReleaseSpec) bool {
			return spec.id == arguments[2]
		}) ||
		!validPythonPackageVersion(arguments[3]) {
		return false
	}
	suffix := ".tar.gz"
	if arguments[0] == pythonWheel {
		suffix = "-py3-none-any.whl"
	}
	return filepath.Base(arguments[1]) == pythonArtifactRoot(arguments[2], arguments[3])+suffix
}

func validPythonPackageVersion(version string) bool {
	const versionLimit = 128
	if len(version) > versionLimit {
		return false
	}
	valid, err := regexp.MatchString(`^[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$`, version)
	return err == nil && valid
}

func pythonArtifactRoot(packageID, version string) string {
	return strings.ReplaceAll(packageID, "-", "_") + "-" + version
}
