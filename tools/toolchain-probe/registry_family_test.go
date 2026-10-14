package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestRegistryFamilyScopedVersions(t *testing.T) {
	t.Parallel()
	for _, override := range []string{"", "--pypi-version=logbrew-sdk=0.3.4"} {
		arguments := strings.Fields("--target=pypi --target=rubygems --target=packagist --version=0.5.6 " + override)
		options := prepareRegistryOptions(arguments)
		if options == nil {
			t.Fatal("family options rejected")
		}
		checks, valid := registryPlanChecks(options.selection, options.versions)
		if !valid {
			t.Fatal("family plan rejected")
		}
		expected := map[string]string{
			registryPythonFamily: "0.5.6", registryRubyFamily: registryRubyVersion,
			registryPackagistFamily: registryPackagistVersion,
		}
		if override != "" {
			expected[registryPythonFamily] = "0.3.4"
		}
		for _, check := range checks {
			version := expected[check.request.family]
			if !reflect.DeepEqual(check.expected, registryExpectedVersions(check.request.family, version)) {
				t.Fatalf("%s version leaked from another registry", check.request.family)
			}
		}
	}
}

func TestRegistryReleasedArguments(t *testing.T) {
	t.Parallel()
	arguments := strings.Fields(`--target=all --require-released-package-set --include-unity-npm`)
	for _, family := range []string{registryNPMFamily, nugetJobName} {
		for _, name := range registryOverridePackages(family) {
			arguments = append(arguments, "--"+family+"-version", name+"="+registryDefaultVersion)
		}
	}
	options := prepareRegistryOptions(arguments)
	if options == nil {
		t.Fatal("exact released maps rejected at command boundary")
	}
	checks, valid := registryPlanChecks(options.selection, options.versions)
	if !valid {
		t.Fatal("exact released map planning failed")
	}
	unity := 0
	for _, check := range checks {
		if check.request.family == registryNPMFamily && check.request.label == registryUnityPackage {
			unity++
		}
	}
	if unity != 1 {
		t.Fatal("Unity must be selected exactly once")
	}
	if prepareRegistryOptions(arguments[:len(arguments)-registryArgumentPairWidth]) != nil {
		t.Fatal("incomplete released NuGet map accepted")
	}
}
