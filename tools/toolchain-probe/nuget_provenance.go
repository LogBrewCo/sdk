package main

import (
	"crypto/sha512"
	"encoding/base64"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type nugetProvenance struct {
	boundDir, sourceDir, packagesDir, assets, coreVersion, httpclientVersion string
}

const (
	nugetReceiptSource = "source"
	nugetReceiptType   = "type"
)

func verifyNugetProvenance(options *nugetProvenance) bool {
	for _, directory := range []string{options.boundDir, options.sourceDir, options.packagesDir} {
		if !filepath.IsAbs(directory) || len(directory) > outputLimit {
			return false
		}
		info, err := os.Stat(directory)
		if err != nil || !info.IsDir() {
			return false
		}
	}
	if sameNugetDirectory(options.boundDir, options.sourceDir) || !filepath.IsAbs(options.assets) {
		return false
	}
	data, readable := readNugetReceipt(filepath.Dir(options.assets), filepath.Base(options.assets), maximumOutputFile)
	document, decoded := decodeCheckDocument(data)
	libraries := eventObject(eventObject(document)["libraries"])
	return readable && decoded && libraries != nil &&
		verifyNugetPackage(options, libraries, dotnetMetadataCore, options.coreVersion, "0.nupkg") &&
		verifyNugetPackage(options, libraries, "LogBrew.HttpClient", options.httpclientVersion, "1.nupkg")
}

func verifyNugetPackage(
	options *nugetProvenance, libraries map[string]any, packageID, version, boundName string,
) bool {
	if !validPythonPackageVersion(version) {
		return false
	}
	library := eventObject(libraries[packageID+"/"+version])
	contentHash, valid := nugetSHA512(library["sha512"])
	if !valid || library[nugetReceiptType] != "package" ||
		!verifyNugetArchives(options, packageID, version, boundName) {
		return false
	}
	filename := path.Join(strings.ToLower(packageID), version, ".nupkg.metadata")
	data, readable := readNugetReceipt(options.packagesDir, filename, pythonManifestLimit)
	document, decoded := decodeCheckDocument(data)
	metadata := eventObject(document)
	installedHash, valid := nugetSHA512(metadata["contentHash"])
	source, text := metadata[nugetReceiptSource].(string)
	// NuGet signed-package content excludes signature data. It is not the
	// complete archive hash above; compare it with the resolver's content hash.
	return readable && decoded && valid && installedHash == contentHash && text &&
		filepath.IsAbs(source) && sameNugetDirectory(source, options.sourceDir)
}

func verifyNugetArchives(options *nugetProvenance, packageID, version, boundName string) bool {
	bound, valid := readNugetReceipt(options.boundDir, boundName, nugetPackageLimit)
	if !valid {
		return false
	}
	digest := sha512.Sum512(bound)
	expected := base64.StdEncoding.EncodeToString(digest[:])
	name := strings.ToLower(packageID)
	filename := name + "." + version + ".nupkg"
	installed := path.Join(name, version, filename)
	for _, artifact := range []struct{ directory, name string }{
		{options.sourceDir, packageID + "." + version + ".nupkg"},
		{options.packagesDir, installed},
	} {
		data, readable := readNugetReceipt(artifact.directory, artifact.name, nugetPackageLimit)
		if !readable || sha512.Sum512(data) != digest {
			return false
		}
	}
	hash, readable := readNugetReceipt(options.packagesDir, installed+".sha512", outputLimit)
	archiveHash, valid := nugetSHA512(strings.TrimSpace(string(hash)))
	return readable && valid && archiveHash == expected
}

func readNugetReceipt(directory, name string, limit int64) ([]byte, bool) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, false
	}
	data, valid := readNugetRootReceipt(root, name, limit)
	closeError := root.Close()
	return data, valid && closeError == nil
}

func readNugetRootReceipt(root *os.Root, name string, limit int64) ([]byte, bool) {
	input, err := openRootCheckInput(root, name)
	if err != nil {
		return nil, false
	}
	return readCheckInputLimit(input, limit)
}

func sameNugetDirectory(left, right string) bool {
	leftInfo, leftError := os.Stat(left)
	rightInfo, rightError := os.Stat(right)
	return leftError == nil && rightError == nil && leftInfo.IsDir() && rightInfo.IsDir() &&
		os.SameFile(leftInfo, rightInfo)
}

func nugetSHA512(value any) (string, bool) {
	text, valid := value.(string)
	if !valid || len(text) != base64.StdEncoding.EncodedLen(sha512.Size) {
		return "", false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(text)
	return text, err == nil && len(decoded) == sha512.Size && base64.StdEncoding.EncodeToString(decoded) == text
}
