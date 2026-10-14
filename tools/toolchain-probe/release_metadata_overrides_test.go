package main

import (
	"io"
	"maps"
	"os"
	"strings"
	"testing"
)

func TestAggregateMetadataOverrides(t *testing.T) {
	t.Parallel()
	for _, arguments := range [][]string{
		{metadataNPMVersionFlag, jsMetadataCore + "=0.1.16"},
		{metadataNugetVersionFlag, "LogBrew=0.1.16"},
		{metadataNPMVersionFlag, jsMetadataCore + "=0.1.16", metadataNugetVersionFlag, "LogBrew=0.1.16"},
	} {
		if !configureReleaseMetadataOverrides(releaseMetadataChecks(), arguments) {
			t.Fatal("valid aggregate version override rejected")
		}
	}
	for _, arguments := range [][]string{
		{metadataNPMVersionFlag},
		{"--invalid-option", "x=1.0.0"},
		{metadataNPMVersionFlag, "unknown=1.0.0"},
		{metadataNugetVersionFlag, "LogBrew=invalid"},
		{metadataNPMVersionFlag, jsMetadataCore + "=1.0.0", metadataNPMVersionFlag, jsMetadataCore + "=1.0.0"},
	} {
		if configureReleaseMetadataOverrides(releaseMetadataChecks(), arguments) {
			t.Fatal("invalid aggregate version override accepted")
		}
		command := append([]string{releaseMetadataAll, t.TempDir()}, arguments...)
		if runReleaseMetadata(command, io.Discard, io.Discard) != exitUsage {
			t.Fatal("invalid aggregate override did not produce usage rejection")
		}
	}
}

func TestAggregateOverridesReachPackageChecks(t *testing.T) {
	t.Parallel()
	files := dotnetMetadataFixture(t)
	maps.Copy(files, jsMetadataFixtureFiles(t))
	const version = "9.8.7"
	project := dotnetMetadataSource + dotnetMetadataHTTP + "/" + dotnetMetadataHTTP + dotnetMetadataProject
	files[project] = strings.Replace(files[project], "<Version>0.1.2</Version>", "<Version>"+version+"</Version>", 1)
	root := publishFixtureRoot(t, confidentialityFixture(t, files))
	checks := map[string]func(*os.Root) bool{
		areaJS: checkJSMetadata, dotnetMetadataFamily: checkDotnetMetadata,
	}
	if checkAllReleaseMetadata(root, checks) {
		t.Fatal("altered NuGet version accepted without override")
	}
	arguments := []string{metadataNugetVersionFlag, dotnetMetadataHTTP + "=" + version}
	if !configureReleaseMetadataOverrides(checks, arguments) || !checkAllReleaseMetadata(root, checks) {
		t.Fatal("matching override did not reach aggregate package check")
	}
	arguments = []string{metadataNPMVersionFlag, jsMetadataCore + "=" + version}
	if !configureReleaseMetadataOverrides(checks, arguments) || checkAllReleaseMetadata(root, checks) {
		t.Fatal("mismatched npm override did not reach aggregate package check")
	}
}
