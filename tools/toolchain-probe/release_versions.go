package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/pelletier/go-toml/v2"
)

const (
	releaseVersionsMode = "release-versions"
	rustCrateManifest   = "rust/logbrew/Cargo.toml"
	mavenNamespace      = "http://maven.apache.org/POM/4.0.0"
)

var (
	repoWideReleaseTag = regexp.MustCompile(
		`^(?:refs/tags/)?v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$`)
	rubyVersion  = regexp.MustCompile(`(?m)^\s*(?:spec\.version|VERSION)\s*=\s*["']([^"']+)["']`)
	gemspecLoads = regexp.MustCompile(`(?m)^\s*require_relative\s+["']([^"']*version)["']`)
)

// checkReleaseVersions fails when a repo-wide release tag differs from any
// package version that the catalog's repo_wide list names. With --rust it
// prints the Rust crate version instead.
func checkReleaseVersions(arguments []string, output, diagnostic io.Writer) int {
	flags := flag.NewFlagSet(releaseVersionsMode, flag.ContinueOnError)
	flags.SetOutput(diagnostic)
	rust := flags.Bool("rust", false, "print the Rust crate version")
	if flags.Parse(arguments) != nil || flags.NArg() > 2 || *rust && flags.NArg() > 1 || !*rust && flags.NArg() == 0 {
		return writeText(diagnostic, "usage: release-versions TAG [root] | release-versions --rust [root]\n", exitUsage)
	}
	if *rust {
		version, err := readManifestVersion(cmpOr(flags.Arg(0), "."), rustCrateManifest)
		if err != nil {
			return writeText(diagnostic, err.Error()+"\n", exitFailure)
		}
		return writeText(output, version+"\n", exitOK)
	}
	catalog, err := loadReleaseCatalog(releaseCatalogText)
	tag, root := flags.Arg(0), cmpOr(flags.Arg(1), ".")
	match := repoWideReleaseTag.FindStringSubmatch(tag)
	if err == nil && match == nil {
		err = errors.New("expected repo-wide release tag like v0.1.1, got " + pyRepr(tag))
	}
	var differing []string
	for _, entry := range catalog.RepoWide {
		var version string
		if err == nil {
			version, err = readManifestVersion(root, entry[2])
		}
		if err == nil && version != match[1] {
			differing = append(differing, fmt.Sprintf("- %s %s: %s (%s)", entry[0], entry[1], version, entry[2]))
		}
	}
	switch {
	case err != nil:
		return writeText(diagnostic, "repo-wide release version check failed: "+err.Error()+"\n", exitFailure)
	case len(differing) > 0:
		return writeText(diagnostic, fmt.Sprintf("repo-wide release tag %s expects every publishable package to be %s, "+
			"but these manifests differ:\n%s\nUse scoped/manual changed-package publishing, or bump every listed package "+
			"before creating the repo-wide %s GitHub Release.\n", tag, match[1], strings.Join(differing, "\n"), tag),
			exitFailure)
	}
	return writeText(output, "repo-wide release package versions ok for "+tag+"\n", exitOK)
}

// readManifestVersion reads a package version the way each ecosystem's
// manifest stores it.
func readManifestVersion(root, relative string) (string, error) {
	data, err := os.ReadFile(filepath.Join(root, relative))
	if err == nil && !utf8.Valid(data) {
		err = errors.New("invalid UTF-8")
	}
	var value any
	if err == nil {
		value, err = manifestVersion(path.Base(relative), data)
	}
	if err != nil {
		return "", fmt.Errorf("%s: %w", relative, err)
	}
	// A gemspec without spec.version takes the VERSION constant from the
	// version file it loads, as the gem itself does.
	if match := gemspecLoads.FindSubmatch(data); value == nil && match != nil && strings.HasSuffix(relative, ".gemspec") {
		return readManifestVersion(root, path.Join(path.Dir(relative), string(match[1])+".rb"))
	}
	if version, ok := value.(string); ok && version != "" {
		return version, nil
	}
	return "", errors.New(relative + ": could not read package version")
}

func manifestVersion(name string, data []byte) (any, error) {
	var payload any
	var err error
	switch {
	case name == "package.json":
		err = json.Unmarshal(data, &payload)
		return field(payload, "version"), err
	case name == "pyproject.toml", name == "Cargo.toml":
		err = toml.Unmarshal(data, &payload)
		return field(payload, map[bool]string{true: "project", false: "package"}[name == "pyproject.toml"], "version"), err
	case strings.HasSuffix(name, ".gemspec"), strings.HasSuffix(name, ".rb"):
		if match := rubyVersion.FindSubmatch(data); match != nil {
			return string(match[1]), nil
		}
		return nil, nil
	case name == "pom.xml", strings.HasSuffix(name, ".csproj"):
		root, err := parseXML(data)
		if name == "pom.xml" {
			return root.findText(mavenNamespace, "version"), err
		}
		return root.findText("", "PropertyGroup", "Version"), err
	}
	return nil, errors.New("unsupported manifest")
}

// findText follows child names in one namespace like ElementTree's findtext:
// the first match in document order, with "" for an element without text.
func (element *xmlElement) findText(space string, names ...string) any {
	if element == nil {
		return nil
	}
	if len(names) == 0 {
		if element.value == nil {
			return ""
		}
		return *element.value
	}
	for _, child := range element.children {
		if child.space == space && child.name == names[0] {
			if text := child.findText(space, names[1:]...); text != nil {
				return text
			}
		}
	}
	return nil
}
