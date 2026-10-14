package main

import "testing"

func TestRegistryOptionsAssembly(t *testing.T) {
	t.Parallel()
	options := assembleRegistryOptions(parseRegistryArguments(nil))
	if options == nil || len(options.selection.targets) != 1 || options.selection.targets[0] != releaseMetadataAll {
		t.Fatal("default target missing")
	}
	options = assembleRegistryOptions(parseRegistryArguments([]string{
		"--target=npm", "--npm-version=@logbrew/sdk=2.3.4",
		"--include-unity-npm", "--require-npm-provenance", "--include-go", "--retries=0",
	}))
	if options == nil || !options.includeGo || !options.versions.provenance || options.numeric.retry.retries != 0 {
		t.Fatal("flags lost in assembly")
	}
	checks, valid := registryPlanChecks(options.selection, options.versions)
	if !valid || len(checks) != 2 || !checks[0].expected["2.3.4"] ||
		checks[1].request.label != registryUnityPackage+" provenance" {
		t.Fatal("assembled override did not reach request plan")
	}
	for _, args := range [][]string{
		{"--target=unknown"},
		{"--npm-package=co.logbrew.unity"},
		{"--npm-version=@logbrew/prisma=1"},
		{"--nuget-version=Unknown=1"},
		{"--maven-artifact=../escape"},
	} {
		if assembleRegistryOptions(parseRegistryArguments(args)) != nil {
			t.Fatalf("accepted %v", args)
		}
	}
	if assembleRegistryOptions(nil) != nil {
		t.Fatal("nil arguments accepted")
	}
}
