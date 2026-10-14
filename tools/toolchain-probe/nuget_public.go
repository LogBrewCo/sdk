package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

const (
	nugetPublicCommand = "nuget-public"
	nugetVersionFlag   = "--nuget-version"
	nugetRangeFlag     = "--dependency-range"
	nugetSourceFlag    = "--source-root"
	nugetCommitFlag    = "--source-commit"
	nugetOutputFlag    = "--output-directory"
)

type nugetPublicOptions struct {
	sourceRoot, sourceCommit, dependencyRange, destination string
	versions                                               []string
}

func runNugetPublic(arguments []string, output, diagnostic io.Writer) int {
	options := parseNugetPublicArguments(arguments)
	if options == nil {
		return writeText(diagnostic, "invalid NuGet public package arguments\n", exitUsage)
	}
	client := newNugetRegistryClient()
	if client == nil {
		return writeText(diagnostic, "NuGet registry client unavailable\n", exitFailure)
	}
	defer client.CloseIdleConnections()
	if !executeNugetPublic(context.Background(), client, options) {
		return writeText(diagnostic, "NuGet public artifact verification or publication failed\n", exitFailure)
	}
	return writeText(output, "NuGet public artifact verification ok\n", exitOK)
}

func parseNugetPublicArguments(arguments []string) *nugetPublicOptions {
	const requiredArguments = 10
	if len(arguments) != requiredArguments && len(arguments) != requiredArguments+2 {
		return nil
	}
	options := new(nugetPublicOptions)
	fields := map[string]*string{
		nugetSourceFlag: &options.sourceRoot, nugetCommitFlag: &options.sourceCommit,
		nugetRangeFlag: &options.dependencyRange, nugetOutputFlag: &options.destination,
	}
	for index := 0; index < len(arguments); index += 2 {
		key, value := arguments[index], arguments[index+1]
		if value == "" || len(value) > outputLimit {
			return nil
		}
		if key == nugetVersionFlag {
			options.versions = append(options.versions, value)
			continue
		}
		field := fields[key]
		if field == nil || *field != "" {
			return nil
		}
		*field = value
	}
	if !options.bindSelection() {
		return nil
	}
	return options
}

func (options *nugetPublicOptions) bindSelection() bool {
	if len(options.versions) != 2 || !pythonLowerHex(options.sourceCommit, pythonSourceCommitSize) ||
		!filepath.IsAbs(options.sourceRoot) || !filepath.IsAbs(options.destination) ||
		filepath.Clean(options.destination) != options.destination ||
		!directDirectoryName(filepath.Base(options.destination)) || options.destination == string(filepath.Separator) {
		return false
	}
	for index, id := range []string{dotnetMetadataCore, dotnetMetadataHTTP} {
		name, version, found := strings.Cut(options.versions[index], "=")
		version = strings.TrimSpace(version)
		if !found || strings.TrimSpace(name) != id || !validPythonPackageVersion(version) {
			return false
		}
		options.versions[index] = version
	}
	if options.dependencyRange == "" {
		options.dependencyRange = dotnetCompatibleRange(options.versions[0])
	}
	return nugetDependencyRange(options.dependencyRange) == options.dependencyRange &&
		strings.HasPrefix(options.dependencyRange, "["+options.versions[0]+", ")
}

func executeNugetPublic(ctx context.Context, client *http.Client, options *nugetPublicOptions) bool {
	ctx, cancel := context.WithTimeout(ctx, maximumDeadline)
	defer cancel()
	if options == nil || client == nil || ctx.Err() != nil || len(options.versions) != 2 {
		return false
	}
	if _, err := os.Lstat(options.destination); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	packages := make([]nugetResolvedPackage, 0, len(options.versions))
	for index, id := range []string{dotnetMetadataCore, dotnetMetadataHTTP} {
		spec := &nugetArtifactSpec{
			id: id, version: options.versions[index], sourceCommit: options.sourceCommit,
			dependencies: readNugetSourceDependencies(options.sourceRoot, id, options.dependencyRange),
		}
		if !spec.valid() {
			return false
		}
		packages = append(packages, nugetResolvedPackage{spec: spec, artifact: nil})
	}
	for index := range packages {
		packages[index].artifact = fetchNugetPublicArtifact(ctx, client, packages[index].spec)
		if packages[index].artifact == nil || ctx.Err() != nil {
			return false
		}
	}
	if ctx.Err() != nil || os.MkdirAll(filepath.Dir(options.destination), pythonBundleDirectoryMode) != nil {
		return false
	}
	return writeNugetPublicBundle(options.destination, packages) && ctx.Err() == nil
}
