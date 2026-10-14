package main

func prepareRegistryOptions(arguments []string) *registryOptions {
	options := assembleRegistryOptions(parseRegistryArguments(arguments))
	if !registryOptionsValid(options) {
		return nil
	}
	if options.planPath == "" {
		return options
	}
	input, err := openCheckInput(options.planPath)
	if err != nil {
		return nil
	}
	data, readable := readCheckInputLimit(input, pythonManifestLimit)
	if !readable {
		return nil
	}
	plan, valid := registryReadMavenPlan(data, options.planScope)
	if !valid {
		return nil
	}
	options.selection.mavenArtifacts = plan.artifacts
	options.selection.mavenPlan = true
	options.versions.overrides[mavenMetadataFamily] = plan.versions
	return options
}
