package main

import (
	"slices"
	"strings"
)

func registryOverridePackages(family string) []string {
	packages := registryPackageCatalog(family)
	switch family {
	case registryNPMFamily:
		packages = append(packages, registryUnityPackage)
	case registryPythonFamily:
		packages = append(packages, pythonFastAPIID, pythonFlaskID, pythonDjangoID)
	case mavenMetadataFamily:
		for index, name := range packages {
			packages[index] = "co.logbrew:" + name
		}
	case nugetJobName:
	default:
		return nil
	}
	return packages
}

//nolint:gocritic // Ordered selectors and lookup values are separate outputs, with validation status.
func registryParseOverrides(family string, raw []string) ([]string, map[string]string, bool) {
	allowed := registryOverridePackages(family)
	if len(allowed) == 0 {
		return nil, nil, false
	}
	names := make([]string, 0, len(raw))
	versions := make(map[string]string, len(raw))
	for _, entry := range raw {
		name, version, found := strings.Cut(entry, "=")
		name, version = strings.TrimSpace(name), strings.TrimSpace(version)
		if !found || version == "" || !slices.Contains(allowed, name) || versions[name] != "" {
			return nil, nil, false
		}
		names = append(names, name)
		versions[name] = version
	}
	return names, versions, true
}
