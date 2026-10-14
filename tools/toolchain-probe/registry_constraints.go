package main

import "slices"

const registryDependencyScope = "dependencies"

func registryOptionsValid(options *registryOptions) bool {
	if options == nil {
		return false
	}
	targets := options.selection.targets
	requirements := map[string]bool{
		registryNPMFamily:    len(options.selection.npmPackages) > 0 || options.versions.provenance,
		registryPythonFamily: len(options.versions.overrides[registryPythonFamily]) > 0,
		nugetJobName:         len(options.versions.overrides[nugetJobName]) > 0,
		mavenMetadataFamily: len(options.selection.mavenArtifacts) > 0 ||
			len(options.versions.overrides[mavenMetadataFamily]) > 0 || options.planPath != "",
	}
	for family, required := range requirements {
		if required && !slices.Contains(targets, family) && !slices.Contains(targets, releaseMetadataAll) {
			return false
		}
	}
	if !registryMavenOptionsValid(options) {
		return false
	}
	if options.versions.absent && (len(targets) != 1 ||
		(targets[0] != nugetJobName && targets[0] != mavenMetadataFamily)) {
		return false
	}
	return !options.released || registryReleasedSelection(options.selection)
}

func registryMavenOptionsValid(options *registryOptions) bool {
	if (options.planPath == "") != (options.planScope == "") {
		return false
	}
	if options.planPath != "" {
		if options.planScope != nugetPlanSelected && options.planScope != registryDependencyScope {
			return false
		}
		if len(options.selection.mavenArtifacts) > 0 || len(options.versions.overrides[mavenMetadataFamily]) > 0 {
			return false
		}
	}
	if options.versions.absent && slices.Equal(options.selection.targets, []string{mavenMetadataFamily}) {
		return options.planPath != "" && options.planScope == nugetPlanSelected
	}
	return true
}
