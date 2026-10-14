package main

import "testing"

func TestRegistryValidSelectors(t *testing.T) {
	t.Parallel()
	if registryValidSelectors(nil) {
		t.Fatal("nil selection accepted")
	}
	selection := new(registrySelection)
	selection.targets = []string{releaseMetadataAll}
	if !registryValidSelectors(selection) {
		t.Fatal("defaults rejected")
	}
	selection.npmPackages = []string{registryUnityPackage}
	if registryValidSelectors(selection) {
		t.Fatal("Unity accepted as explicit npm selector")
	}
	selection.npmPackages = nil
	selection.npmVersionPackages = []string{registryUnityPackage}
	if !registryValidSelectors(selection) {
		t.Fatal("Unity version override rejected")
	}
	for _, name := range []string{"../../registry-selector-escape", jsMetadataScope + "prisma", fixtureUnknown} {
		selection.npmVersionPackages = []string{name}
		if registryValidSelectors(selection) {
			t.Fatalf("accepted npm selector %q", name)
		}
	}
	selection.npmVersionPackages = nil
	selection.nugetVersionPackages = []string{fixtureUnknown}
	if registryValidSelectors(selection) {
		t.Fatal("unknown NuGet selector accepted")
	}
	selection.nugetVersionPackages = nil
	selection.mavenArtifacts = []string{"co.logbrew:logbrew-kotlin"}
	if registryValidSelectors(selection) {
		t.Fatal("coordinate accepted as artifact id")
	}
}

func TestRegistryReleasedSelection(t *testing.T) {
	t.Parallel()
	selection := new(registrySelection)
	selection.targets = []string{releaseMetadataAll}
	selection.npmVersionPackages = registryPackageCatalog(registryNPMFamily)
	selection.nugetVersionPackages = registryPackageCatalog(nugetJobName)
	if !registryReleasedSelection(selection) {
		t.Fatal("complete maps rejected")
	}
	selection.unity = true
	if registryReleasedSelection(selection) {
		t.Fatal("Unity requirement omitted")
	}
	selection.npmVersionPackages = append(selection.npmVersionPackages, registryUnityPackage)
	if !registryReleasedSelection(selection) {
		t.Fatal("complete Unity map rejected")
	}
	selection.npmVersionPackages[0] = selection.npmVersionPackages[1]
	if registryReleasedSelection(selection) {
		t.Fatal("duplicate map accepted")
	}
	selection.npmVersionPackages = registryOverridePackages(registryNPMFamily)
	selection.targets = []string{registryNPMFamily, nugetJobName}
	if registryReleasedSelection(selection) {
		t.Fatal("released set accepted without all target")
	}
	selection.targets = []string{releaseMetadataAll}
	selection.npmPackages = []string{jsMetadataCore}
	if registryReleasedSelection(selection) {
		t.Fatal("restricted released set accepted")
	}
}
