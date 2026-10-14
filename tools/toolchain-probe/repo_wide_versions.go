package main

import (
	"encoding/json"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

const repoWideVersionsMode = "repo-wide-versions"

type repoWideManifest struct {
	read func([]byte) string
	name string
}

type repoWideVersionMismatch struct {
	Name     string `json:"name"`
	Manifest string `json:"manifest"`
	Version  string `json:"version"`
}

type repoWideVersionReceipt struct {
	ExpectedVersion string                    `json:"expected_version"`
	Mismatches      []repoWideVersionMismatch `json:"mismatches"`
	PackagesChecked int                       `json:"packages_checked"`
	Valid           bool                      `json:"valid"`
}

func runRepoWideVersions(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 2 || !filepath.IsAbs(arguments[1]) || repoWideReleaseVersion(arguments[0]) == "" {
		return writeText(diagnostic,
			"repo-wide-versions requires a release tag and absolute repository directory\n", exitUsage)
	}
	root, err := os.OpenRoot(arguments[1])
	if err != nil {
		return writeText(diagnostic, "Release version repository unavailable\n", exitFailure)
	}
	receipt, readable := collectRepoWideVersions(root, repoWideReleaseVersion(arguments[0]))
	if closeError := root.Close(); !readable || closeError != nil {
		return writeText(diagnostic, "Release manifest version unavailable or invalid\n", exitFailure)
	}
	if err := json.NewEncoder(output).Encode(receipt); err != nil {
		return exitFailure
	}
	if !receipt.Valid {
		return writeText(diagnostic,
			"Package versions differ; use scoped publishing or align the listed manifests\n", exitFailure)
	}
	return exitOK
}

func repoWideReleaseVersion(tag string) string {
	const maximumTagBytes = 128
	if len(tag) > maximumTagBytes {
		return ""
	}
	version, prefixed := strings.CutPrefix(strings.TrimPrefix(tag, "refs/tags/"), "v")
	pattern := `^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`
	if !prefixed || !regexp.MustCompile(pattern).MatchString(version) {
		return ""
	}
	return version
}

func collectRepoWideVersions(root *os.Root, expected string) (repoWideVersionReceipt, bool) {
	receipt := repoWideVersionReceipt{
		ExpectedVersion: expected, Mismatches: []repoWideVersionMismatch{}, PackagesChecked: 0, Valid: false,
	}
	for filename, manifest := range repoWideVersionManifests() {
		data, readable := readReleaseMetadata(root, filename)
		version := manifest.read(data)
		if !readable || repoWideReleaseVersion("v"+version) == "" {
			return repoWideVersionReceipt{}, false
		}
		receipt.PackagesChecked++
		if version != expected {
			receipt.Mismatches = append(receipt.Mismatches, repoWideVersionMismatch{manifest.name, filename, version})
		}
	}
	slices.SortFunc(receipt.Mismatches, func(left, right repoWideVersionMismatch) int {
		return strings.Compare(left.Manifest, right.Manifest)
	})
	receipt.Valid = len(receipt.Mismatches) == 0
	return receipt, true
}

func repoWideVersionManifests() map[string]repoWideManifest {
	manifests := map[string]repoWideManifest{
		rustMetadataManifest:                          {tomlVersionReader("package"), releaseMetadataKeyword},
		rubyMetadataPrefix + "lib/logbrew/version.rb": {rubyConstantVersion, pythonCoreID},
	}
	for directory, name := range jsMetadataPackages() {
		manifests[path.Join(directory, jsMetadataManifest)] = repoWideManifest{jsonPackageVersion, name}
	}
	for _, spec := range pythonReleaseCatalog() {
		manifest := path.Join(pythonMetadataDirectory, spec.directory, pythonMetadataManifest)
		manifests[manifest] = repoWideManifest{tomlVersionReader("project"), spec.id}
	}
	for _, pkg := range dotnetMetadataPackages() {
		manifest := path.Join(dotnetMetadataSource, pkg.id, pkg.id+dotnetMetadataProject)
		manifests[manifest] = repoWideManifest{func(data []byte) string {
			return dotnetProjectProperties(data).value(dotnetMetadataVersion)
		}, pkg.id}
	}
	for _, pkg := range mavenMetadataPackages() {
		manifests[pkg.prefix+mavenMetadataPOM] = repoWideManifest{func(data []byte) string {
			project := parseMetadataXML(data)
			if project == nil || project.name != "project" || project.namespace != mavenMetadataNamespace ||
				!project.hasNamespace(mavenMetadataNamespace) {
				return ""
			}
			return project.value(pythonManifestVersion)
		}, "co.logbrew:" + pkg.artifact}
	}
	return manifests
}

func jsonPackageVersion(data []byte) string {
	document, valid := decodeCheckJSON(data)
	if !valid {
		return ""
	}
	version, text := eventObject(document)[pythonManifestVersion].(string)
	if !text {
		return ""
	}
	return version
}

func tomlVersionReader(section string) func([]byte) string {
	return func(data []byte) string {
		version, text := decodeReleaseMetadata(data, section)[pythonManifestVersion].(string)
		if !text {
			return ""
		}
		return version
	}
}

func rubyConstantVersion(data []byte) string {
	if !validMetadataText(data, nil) {
		return ""
	}
	pattern := `(?s)\A\s*(?:#[^\n]*\n\s*)*module LogBrew\s+VERSION = "([0-9A-Za-z.+-]+)"\s+end\s*\z`
	match := regexp.MustCompile(pattern).FindSubmatch(data)
	const matchedGroups = 2
	if len(match) != matchedGroups {
		return ""
	}
	return string(match[1])
}
