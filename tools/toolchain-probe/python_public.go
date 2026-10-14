package main

import (
	"net/url"
	"path"
	"slices"
	"strings"
)

const (
	pythonPublicHost     = "files.pythonhosted.org"
	pythonPublicType     = "bdist_wheel"
	pythonPublicFilename = "filename"
	pythonPublicURL      = "url"
	pythonPublicURLs     = "urls"
	pythonPublicName     = "name"
)

type pythonPublicArtifact struct {
	url, sha256 string
}

func validPythonPublicURL(raw, filename string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host == pythonPublicHost && parsed.User == nil &&
		parsed.RawQuery == "" && !parsed.ForceQuery && !strings.Contains(raw, "#") &&
		!strings.Contains(parsed.EscapedPath(), "%") && strings.HasPrefix(parsed.Path, "/") &&
		safePythonArchiveName(strings.TrimPrefix(parsed.Path, "/")) && path.Base(parsed.Path) == filename
}

func parsePythonPublicMetadata(
	data []byte, spec pythonReleaseSpec, version string,
) (map[string]pythonPublicArtifact, bool) {
	if !slices.Contains(pythonReleaseCatalog(), spec) || !validPythonPackageVersion(version) {
		return nil, false
	}
	document, readable := readPythonManifestDocument(data)
	root, isObject := document.(map[string]any)
	info, hasInfo := root["info"].(map[string]any)
	files, hasFiles := root[pythonPublicURLs].([]any)
	if !readable || !isObject || !hasInfo || !hasFiles || len(files) != pythonReleaseFileCount ||
		info[pythonPublicName] != spec.id || info[pythonManifestVersion] != version {
		return nil, false
	}
	result := make(map[string]pythonPublicArtifact, pythonReleaseFileCount)
	for _, entry := range files {
		kind, artifact, valid := pythonPublicFile(entry, spec, version)
		if !valid || result[kind].url != "" {
			return nil, false
		}
		result[kind] = artifact
	}
	return result, true
}

func pythonPublicFile(entry any, spec pythonReleaseSpec, version string) (string, pythonPublicArtifact, bool) {
	file, isObject := entry.(map[string]any)
	digests, hasDigests := file["digests"].(map[string]any)
	filename, hasName := file[pythonPublicFilename].(string)
	digest, hasDigest := digests[pythonManifestHash].(string)
	address, hasURL := file[pythonPublicURL].(string)
	if !isObject || !hasDigests || !hasName || !hasDigest || !hasURL ||
		!pythonLowerHex(digest, pythonArtifactHashSize) || !validPythonPublicURL(address, filename) {
		return "", pythonPublicArtifact{}, false
	}
	for _, kind := range []string{pythonWheel, pythonSdist} {
		packageType := pythonSdist
		if kind == pythonWheel {
			packageType = pythonPublicType
		}
		if filename == path.Base(pythonReleaseArtifactPath(spec, version, kind)) && file["packagetype"] == packageType {
			return kind, pythonPublicArtifact{url: address, sha256: digest}, true
		}
	}
	return "", pythonPublicArtifact{}, false
}
