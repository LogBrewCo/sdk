package main

import (
	"encoding/json"
	"slices"
)

type registryMavenPlan struct {
	versions  map[string]string
	artifacts []string
}

func registryReadMavenPlan(data []byte, scope string) (registryMavenPlan, bool) {
	empty := registryMavenPlan{versions: nil, artifacts: nil}
	key := nugetPlanSelected
	switch scope {
	case nugetPlanSelected:
	case registryDependencyScope:
		key = "externalDependencies"
	default:
		return empty, false
	}
	document, valid := decodeCheckDocument(data)
	if !valid {
		return empty, false
	}
	plan, valid := document.(map[string]any)
	if !valid || plan["schemaVersion"] != json.Number("1") {
		return empty, false
	}
	entries, valid := plan[key].([]any)
	if !valid {
		return empty, false
	}
	result := registryMavenPlan{versions: make(map[string]string), artifacts: make([]string, 0, len(entries))}
	allowed := registryPackageCatalog(mavenMetadataFamily)
	for _, raw := range entries {
		entry, ok := registryMavenPlanEntry(raw, allowed)
		if !ok || result.versions[entry.coordinate] != "" {
			return empty, false
		}
		result.artifacts = append(result.artifacts, entry.artifact)
		result.versions[entry.coordinate] = entry.version
	}
	if scope == nugetPlanSelected && len(result.artifacts) == 0 {
		return empty, false
	}
	return result, true
}

type registryMavenCoordinate struct{ artifact, coordinate, version string }

func registryMavenPlanEntry(raw any, allowed []string) (registryMavenCoordinate, bool) {
	empty := registryMavenCoordinate{artifact: "", coordinate: "", version: ""}
	entry, ok := raw.(map[string]any)
	if !ok {
		return empty, false
	}
	artifact, artifactOK := entry["artifactId"].(string)
	coordinate, coordinateOK := entry["coordinate"].(string)
	version, versionOK := entry[pythonManifestVersion].(string)
	if !artifactOK || !slices.Contains(allowed, artifact) || !coordinateOK ||
		coordinate != "co.logbrew:"+artifact || !versionOK || version == "" {
		return empty, false
	}
	return registryMavenCoordinate{artifact: artifact, coordinate: coordinate, version: version}, true
}
