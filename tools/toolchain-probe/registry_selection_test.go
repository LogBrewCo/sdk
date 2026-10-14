package main

import (
	"reflect"
	"testing"
)

func TestRegistrySelectedFamilies(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.targets = []string{releaseMetadataAll, registryCratesFamily, registryCratesFamily}
	selection.maven = true
	got, valid := registrySelectedFamilies(selection)
	want := []string{
		registryNPMFamily, registryPythonFamily, registryRubyFamily, nugetJobName,
		registryCratesFamily, mavenMetadataFamily,
	}
	if !valid || !reflect.DeepEqual(got, want) {
		t.Fatalf("families = %v, valid %v", got, valid)
	}
	selection.targets = []string{registryNPMFamily}
	selection.openupm = true
	got, valid = registrySelectedFamilies(selection)
	if !valid || !reflect.DeepEqual(got, []string{registryNPMFamily}) {
		t.Fatal("include flag expanded explicit target")
	}
	for _, targets := range [][]string{nil, {fixtureUnknown}, {releaseMetadataAll, fixtureUnknown}} {
		selection.targets = targets
		if _, valid = registrySelectedFamilies(selection); valid {
			t.Fatalf("accepted targets %v", targets)
		}
	}
}

func TestRegistrySelectedPackages(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.npmPackages = []string{registryUnityPackage}
	selection.npmVersionPackages = []string{jsMetadataCore}
	selection.unity = true
	if got := registrySelectedPackages(selection, registryNPMFamily); !reflect.DeepEqual(got, selection.npmPackages) {
		t.Fatal("explicit selection lost precedence or duplicated Unity")
	}
	selection.npmPackages = nil
	got := registrySelectedPackages(selection, registryNPMFamily)
	if !reflect.DeepEqual(got, []string{jsMetadataCore, registryUnityPackage}) {
		t.Fatalf("npm selection = %v", got)
	}
	got[0] = fixtureUnknown
	if selection.npmVersionPackages[0] != jsMetadataCore {
		t.Fatal("mutated caller input")
	}
	selection.pythonExtras = true
	if got = registrySelectedPackages(selection, registryPythonFamily); !reflect.DeepEqual(got,
		[]string{pythonCoreID, pythonFastAPIID, pythonFlaskID, pythonDjangoID}) {
		t.Fatalf("extras = %v", got)
	}
	selection.nugetVersionPackages = []string{dotnetMetadataHTTP}
	got = registrySelectedPackages(selection, nugetJobName)
	if !reflect.DeepEqual(got, selection.nugetVersionPackages) {
		t.Fatal("NuGet override selection lost")
	}
	selection.mavenPlan = true
	if got = registrySelectedPackages(selection, mavenMetadataFamily); len(got) != 0 {
		t.Fatal("empty Maven plan selected defaults")
	}
	selection.mavenArtifacts = []string{mavenMetadataKotlin}
	got = registrySelectedPackages(selection, mavenMetadataFamily)
	if !reflect.DeepEqual(got, selection.mavenArtifacts) {
		t.Fatal("Maven artifacts lost selection")
	}
}

func TestRegistryGoSelection(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.targets = []string{areaGo}
	families, valid := registrySelectedFamilies(selection)
	if !valid || len(families) != 0 {
		t.Fatal("Go target treated as HTTP registry")
	}
}
