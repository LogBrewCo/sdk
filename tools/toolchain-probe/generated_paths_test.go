package main

import "testing"

func TestGeneratedExactPaths(t *testing.T) {
	t.Parallel()
	const predecessorExactCount = 32
	paths := generatedExactPaths()
	if len(paths) != predecessorExactCount {
		t.Fatal("generated artifact exact catalog changed")
	}
	for _, name := range paths {
		if !generatedArtifactPath(name) {
			t.Fatalf("generated artifact missed: %s", name)
		}
	}
}

func TestGeneratedScopedPatterns(t *testing.T) {
	t.Parallel()
	for name, want := range map[string]bool{
		"tests/__pycache__": true, "examples/test.pyc": true, ".git/test.pyc": false,
		"dotnet/logbrew-dotnet/src/LogBrew/bin": true, "dotnet/logbrew-dotnet/pkg.nupkg": true,
		"unity/logbrew-unity/nested/obj": true, "unity/logbrew-unity/pkg.tgz": true,
		"kotlin/logbrew-kotlin/pkg.jar": true, "kotlin/logbrew-kotlin-okhttp/nested/pkg.jar": true,
		"c/logbrew-c/nested/file.o": true, "cpp/logbrew-cpp/file.a": true, "objc/logbrew-objc/file.o": true,
		"dotnet/logbrew-dotnet-extra/bin": false, "other/pkg.nupkg": false, "other/file.o": false,
		"js/logbrew-js/index.js": false, "docs/public.md": false, "other/target": false,
	} {
		if generatedArtifactPath(name) != want {
			t.Fatalf("artifact classification for %s = %t, want %t", name, !want, want)
		}
	}
}
