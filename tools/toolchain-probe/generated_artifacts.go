package main

import (
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

const generatedArtifactsMode = "generated-artifacts"

var (
	// Build and package output that a verifier run must remove.
	generatedPaths = []string{
		"Cargo.lock", "php/logbrew-php/composer.lock", "php/logbrew-php/vendor",
		"js/logbrew-js/examples/node_modules", "js/logbrew-js/examples/pnpm-lock.yaml", "target", ".mypy_cache",
		".ruff_cache", "java/logbrew-java/build", "python/logbrew_py/build", "python/logbrew_py/dist",
		"python/logbrew_py/src/logbrew_sdk.egg-info", "python/logbrew_fastapi/build",
		"python/logbrew_fastapi/dist", "python/logbrew_fastapi/src/logbrew_fastapi.egg-info",
		"python/logbrew_flask/build", "python/logbrew_flask/dist",
		"python/logbrew_flask/src/logbrew_flask.egg-info", "python/logbrew_django/build",
		"python/logbrew_django/dist", "python/logbrew_django/src/logbrew_django.egg-info",
		"swift/logbrew-swift/.build", "kotlin/logbrew-kotlin/build", "kotlin/logbrew-kotlin/.gradle",
		"kotlin/logbrew-kotlin-okhttp/build", "kotlin/logbrew-kotlin-okhttp/.gradle", "c/logbrew-c/build",
		"c/logbrew-c/examples/build", "cpp/logbrew-cpp/build", "cpp/logbrew-cpp/examples/build",
		"objc/logbrew-objc/build", "objc/logbrew-objc/examples/build",
	}
	// A pattern without a slash matches a name at any depth; "dir/**/name"
	// matches name anywhere under dir.
	generatedPatterns = []string{
		"__pycache__", "*.pyc", "dotnet/logbrew-dotnet/**/bin", "dotnet/logbrew-dotnet/**/obj",
		"dotnet/logbrew-dotnet/**/*.nupkg", "unity/logbrew-unity/**/bin", "unity/logbrew-unity/**/obj",
		"unity/logbrew-unity/**/*.tgz", "kotlin/logbrew-kotlin/**/*.jar", "kotlin/logbrew-kotlin-okhttp/**/*.jar",
		"c/logbrew-c/**/*.o", "c/logbrew-c/**/*.a", "cpp/logbrew-cpp/**/*.o", "cpp/logbrew-cpp/**/*.a",
		"objc/logbrew-objc/**/*.o", "objc/logbrew-objc/**/*.a",
	}
)

// checkGeneratedArtifacts fails when build or package output remains in the tree.
func checkGeneratedArtifacts(arguments []string, output, diagnostic io.Writer) int {
	if len(arguments) != 1 {
		return writeText(diagnostic, "usage: generated-artifacts <repository-root>\n", exitUsage)
	}
	found := generatedArtifacts(arguments[0])
	if len(found) == 0 {
		return writeText(output, "generated artifact hygiene ok\n", exitOK)
	}
	report := "generated artifact hygiene failed:\n- generated artifact remains: " +
		strings.Join(found, "\n- generated artifact remains: ") +
		"\nremove disposable build/package output before committing or reporting a clean cycle\n"
	return writeText(diagnostic, report, exitFailure)
}

func generatedArtifacts(root string) []string {
	var found []string
	for _, item := range generatedPaths {
		if _, err := os.Stat(filepath.Join(root, item)); err == nil {
			found = append(found, item)
		}
	}
	_ = filepath.WalkDir(root, func(current string, entry fs.DirEntry, err error) error {
		if err != nil || current == root {
			return nil
		}
		if entry.IsDir() && entry.Name() == ".git" {
			return filepath.SkipDir
		}
		relative, _ := filepath.Rel(root, current)
		relative = filepath.ToSlash(relative)
		if slices.ContainsFunc(generatedPatterns, func(pattern string) bool { return generatedMatch(pattern, relative) }) {
			found = append(found, relative)
		}
		return nil
	})
	slices.Sort(found)
	return slices.Compact(found)
}

func generatedMatch(pattern, relative string) bool {
	directory, name, nested := strings.Cut(pattern, "/**/")
	if nested && !strings.HasPrefix(relative, directory+"/") {
		return false
	}
	if !nested {
		name = pattern
	}
	matched, _ := path.Match(name, path.Base(relative))
	return matched
}
