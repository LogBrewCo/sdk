package main

import "slices"

func registryKnownSelectors(names, allowed []string) bool {
	for _, name := range names {
		if !slices.Contains(allowed, name) {
			return false
		}
	}
	return true
}

func registryValidSelectors(selection *registrySelection) bool {
	if selection == nil {
		return false
	}
	if _, valid := registrySelectedFamilies(selection); !valid {
		return false
	}
	return registryKnownSelectors(selection.npmPackages, registryPackageCatalog(registryNPMFamily)) &&
		registryKnownSelectors(selection.npmVersionPackages, registryOverridePackages(registryNPMFamily)) &&
		registryKnownSelectors(selection.nugetVersionPackages, registryPackageCatalog(nugetJobName)) &&
		registryKnownSelectors(selection.mavenArtifacts, registryPackageCatalog(mavenMetadataFamily))
}

func registryReleasedSelection(selection *registrySelection) bool {
	if !registryValidSelectors(selection) || !slices.Contains(selection.targets, releaseMetadataAll) ||
		len(selection.npmPackages) > 0 {
		return false
	}
	npm := registryPackageCatalog(registryNPMFamily)
	if selection.unity {
		npm = append(npm, registryUnityPackage)
	}
	return registryExactSelectors(selection.npmVersionPackages, npm) &&
		registryExactSelectors(selection.nugetVersionPackages, registryPackageCatalog(nugetJobName))
}

func registryExactSelectors(names, required []string) bool {
	if len(names) != len(required) {
		return false
	}
	seen := make(map[string]bool, len(names))
	for _, name := range names {
		if seen[name] || !slices.Contains(required, name) {
			return false
		}
		seen[name] = true
	}
	return true
}
