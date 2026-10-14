package main

import "slices"

type registryOptions struct {
	selection           *registrySelection
	versions            *registryVersionPolicy
	numeric             *registryNumericOptions
	planPath, planScope string
	includeGo, released bool
}

func assembleRegistryOptions(arguments *registryArguments) *registryOptions {
	numeric := registryNumericArguments(arguments)
	if numeric == nil {
		return nil
	}
	selection := &registrySelection{
		targets: slices.Clone(arguments.values["target"]), npmPackages: slices.Clone(arguments.values["npm-package"]),
		mavenArtifacts: slices.Clone(arguments.values["maven-artifact"]), npmVersionPackages: nil,
		nugetVersionPackages: nil,
		crates:               arguments.switches["include-crates"], packagist: arguments.switches["include-packagist"],
		maven: arguments.switches["include-maven"], openupm: arguments.switches["include-openupm"],
		unity: arguments.switches["include-unity-npm"], pythonExtras: arguments.switches["include-pypi-extras"],
		mavenPlan: false,
	}
	if len(selection.targets) == 0 {
		selection.targets = []string{releaseMetadataAll}
	}
	versions := newRegistryVersionPolicy()
	versions.version = registryLastValue(arguments, "version", registryDefaultVersion)
	versions.provenance = arguments.switches["require-npm-provenance"]
	versions.absent = arguments.switches["expect-absent"]
	for _, family := range []string{registryNPMFamily, registryPythonFamily, nugetJobName, mavenMetadataFamily} {
		names, overrides, valid := registryParseOverrides(family, arguments.values[family+"-version"])
		if !valid {
			return nil
		}
		versions.overrides[family] = overrides
		switch family {
		case registryNPMFamily:
			selection.npmVersionPackages = names
		case nugetJobName:
			selection.nugetVersionPackages = names
		default:
		}
	}
	if !registryValidSelectors(selection) {
		return nil
	}
	return &registryOptions{
		selection: selection, versions: versions, numeric: numeric,
		planPath:  registryLastValue(arguments, "maven-plan", ""),
		planScope: registryLastValue(arguments, "maven-plan-scope", ""),
		includeGo: arguments.switches["include-go"], released: arguments.switches["require-released-package-set"],
	}
}
