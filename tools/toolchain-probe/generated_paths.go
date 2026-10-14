package main

import (
	"path"
	"slices"
	"strings"
)

const (
	generatedCargoLock       = "Cargo.lock"
	generatedRustTarget      = "target"
	generatedBinaryDirectory = "bin"
	generatedObjectDirectory = "obj"
)

func generatedExactPaths() []string {
	return []string{
		generatedCargoLock, "php/logbrew-php/composer.lock", "php/logbrew-php/vendor",
		"js/logbrew-js/examples/node_modules", "js/logbrew-js/examples/pnpm-lock.yaml",
		generatedRustTarget, ".mypy_cache", ".ruff_cache", "java/logbrew-java/build",
		"python/logbrew_py/build", "python/logbrew_py/dist", "python/logbrew_py/src/logbrew_sdk.egg-info",
		"python/logbrew_fastapi/build", "python/logbrew_fastapi/dist",
		"python/logbrew_fastapi/src/logbrew_fastapi.egg-info",
		"python/logbrew_flask/build", "python/logbrew_flask/dist", "python/logbrew_flask/src/logbrew_flask.egg-info",
		"python/logbrew_django/build", "python/logbrew_django/dist",
		"python/logbrew_django/src/logbrew_django.egg-info",
		"swift/logbrew-swift/.build", "kotlin/logbrew-kotlin/build", "kotlin/logbrew-kotlin/.gradle",
		"kotlin/logbrew-kotlin-okhttp/build", "kotlin/logbrew-kotlin-okhttp/.gradle",
		"c/logbrew-c/build", "c/logbrew-c/examples/build", "cpp/logbrew-cpp/build", "cpp/logbrew-cpp/examples/build",
		"objc/logbrew-objc/build", "objc/logbrew-objc/examples/build",
	}
}

func generatedArtifactPath(name string) bool {
	if slices.Contains(generatedExactPaths(), name) {
		return true
	}
	if slices.Contains(strings.Split(name, "/"), generatedGitDirectory) {
		return false
	}
	leaf := path.Base(name)
	if leaf == "__pycache__" || strings.HasSuffix(leaf, ".pyc") {
		return true
	}
	for _, rule := range []struct {
		prefix     string
		leaves     []string
		extensions []string
	}{
		{"dotnet/logbrew-dotnet/", []string{generatedBinaryDirectory, generatedObjectDirectory}, []string{".nupkg"}},
		{"unity/logbrew-unity/", []string{generatedBinaryDirectory, generatedObjectDirectory}, []string{".tgz"}},
		{"kotlin/logbrew-kotlin/", nil, []string{".jar"}},
		{"kotlin/logbrew-kotlin-okhttp/", nil, []string{".jar"}},
		{"c/logbrew-c/", nil, []string{".o", ".a"}},
		{"cpp/logbrew-cpp/", nil, []string{".o", ".a"}},
		{"objc/logbrew-objc/", nil, []string{".o", ".a"}},
	} {
		if strings.HasPrefix(name, rule.prefix) &&
			(slices.Contains(rule.leaves, leaf) || slices.Contains(rule.extensions, path.Ext(leaf))) {
			return true
		}
	}
	return false
}
