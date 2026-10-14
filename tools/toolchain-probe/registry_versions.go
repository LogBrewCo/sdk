package main

const (
	registryInfoField     = "info"
	registryVersionsField = "versions"
)

// Registry payload extractors preserve upstream version labels. Version selection
// and package policy validation happen separately.
func registryNPMVersions(payload any) map[string]bool {
	return registryObjectVersions(payload, "dist-tags", registryLatestTag, registryVersionsField)
}

func registryPyPIVersions(payload any) map[string]bool {
	return registryObjectVersions(payload, registryInfoField, pythonManifestVersion, "releases")
}

func registryObjectVersions(payload any, metadata, current, entries string) map[string]bool {
	versions := make(map[string]bool)
	object, valid := payload.(map[string]any)
	if !valid {
		return versions
	}
	if info, ok := object[metadata].(map[string]any); ok {
		if version, text := info[current].(string); text && version != "" {
			versions[version] = true
		}
	}
	if releases, ok := object[entries].(map[string]any); ok {
		for version := range releases {
			versions[version] = true
		}
	}
	return versions
}

func registryRubyVersions(payload any) map[string]bool {
	versions := make(map[string]bool)
	if object, valid := payload.(map[string]any); valid {
		if version, text := object[pythonManifestVersion].(string); text && version != "" {
			versions[version] = true
		}
	}
	return versions
}

func registryNugetVersions(payload any) map[string]bool {
	versions := make(map[string]bool)
	if object, valid := payload.(map[string]any); valid {
		if entries, array := object[registryVersionsField].([]any); array {
			for _, entry := range entries {
				if version, text := entry.(string); text {
					versions[version] = true
				}
			}
		}
	}
	return versions
}

func registryPackagistVersions(payload any, packageName string) map[string]bool {
	versions := make(map[string]bool)
	object, valid := payload.(map[string]any)
	if !valid {
		return versions
	}
	packages, valid := object["packages"].(map[string]any)
	if !valid {
		return versions
	}
	entries, valid := packages[packageName].([]any)
	if !valid {
		return versions
	}
	for _, entry := range entries {
		item, valid := entry.(map[string]any)
		if !valid {
			continue
		}
		if version, text := item[pythonManifestVersion].(string); text {
			versions[version] = true
		}
	}
	return versions
}
