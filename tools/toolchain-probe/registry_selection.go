package main

import "slices"

type registrySelection struct {
	targets, npmPackages, npmVersionPackages, nugetVersionPackages, mavenArtifacts []string
	crates, packagist, maven, openupm, unity, pythonExtras, mavenPlan              bool
}

func registrySelectedFamilies(selection *registrySelection) ([]string, bool) {
	order := []string{
		registryNPMFamily, registryPythonFamily, registryRubyFamily, nugetJobName,
		registryPackagistFamily, registryCratesFamily, mavenMetadataFamily, registryOpenUPMFamily,
	}
	requested := make(map[string]bool)
	for _, family := range selection.targets {
		if family != releaseMetadataAll && family != areaGo && !slices.Contains(order, family) {
			return nil, false
		}
		requested[family] = true
	}
	if requested[releaseMetadataAll] {
		for _, family := range order[:4] {
			requested[family] = true
		}
		requested[registryCratesFamily] = requested[registryCratesFamily] || selection.crates
		requested[registryPackagistFamily] = requested[registryPackagistFamily] || selection.packagist
		requested[mavenMetadataFamily] = requested[mavenMetadataFamily] || selection.maven
		requested[registryOpenUPMFamily] = requested[registryOpenUPMFamily] || selection.openupm
	}
	families := make([]string, 0, len(order))
	for _, family := range order {
		if requested[family] {
			families = append(families, family)
		}
	}
	return families, len(families) > 0 || requested[areaGo]
}

func registrySelectedPackages(selection *registrySelection, family string) []string {
	packages := registryPackageCatalog(family)
	switch family {
	case registryNPMFamily:
		if len(selection.npmPackages) > 0 {
			packages = slices.Clone(selection.npmPackages)
		} else if len(selection.npmVersionPackages) > 0 {
			packages = slices.Clone(selection.npmVersionPackages)
		}
		if selection.unity && !slices.Contains(packages, registryUnityPackage) {
			packages = append(packages, registryUnityPackage)
		}
	case registryPythonFamily:
		if selection.pythonExtras {
			packages = append(packages, pythonFastAPIID, pythonFlaskID, pythonDjangoID)
		}
	case nugetJobName:
		if len(selection.nugetVersionPackages) > 0 {
			packages = slices.Clone(selection.nugetVersionPackages)
		}
	case mavenMetadataFamily:
		if selection.mavenPlan || len(selection.mavenArtifacts) > 0 {
			packages = slices.Clone(selection.mavenArtifacts)
		}
	default:
	}
	return packages
}
